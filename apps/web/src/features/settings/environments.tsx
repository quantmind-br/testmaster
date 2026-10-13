import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { api } from "../../api";
import { ApiError } from "../../api/client";
import type { Me } from "../../api/session";
import { ConfirmButton } from "../../components/confirm-action";
import type { Column } from "../../components/data-table";
import { ErrorBanner } from "../../components/error-banner";
import { ErrorSummary, type FieldIssue, FormField } from "../../components/form";
import { ImpactPanel } from "../../components/impact-panel";
import { SearchableTable } from "../../components/searchable-table";
import { UntrustedText } from "../../components/untrusted-text";
import { StatusView, ViewState } from "../../components/view-state";
import { usePaged } from "../../hooks/use-resource";
import { type EnvironmentSettings, environmentImpact } from "../../lib/impact";
import type { ProjectSummary } from "../../routes/home";

export interface Environment {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly activeRevisionId: string;
  readonly archivedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface EnvironmentRevision {
  readonly id: string;
  readonly createdAt: string;
  readonly targetOrigins: readonly string[];
  readonly networkProfile: string;
  readonly production: boolean;
  readonly locale: string;
  readonly timezone: string;
}

const networkProfiles = [
  { value: "public", label: "Public internet" },
  { value: "private", label: "Private network" },
  { value: "local-loopback", label: "Local loopback only" },
] as const;

function parseTarget(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

interface EditorProps {
  readonly project: ProjectSummary;
  readonly projectEtag: string | null;
  readonly workspaceName: string;
  readonly environment: Environment | null;
  readonly onDone: () => void;
  readonly onReloadList: () => void;
}

/** Create or edit one environment; the impact panel updates with every field before saving. */
function EnvironmentEditor(props: EditorProps): ReactNode {
  const { environment } = props;
  const revisions = usePaged<EnvironmentRevision>(
    environment ? `/environments/${encodeURIComponent(environment.id)}/revisions` : "/projects",
    undefined,
    20,
  );
  const current = environment
    ? (revisions.items.find((item) => item.id === environment.activeRevisionId) ?? null)
    : null;
  if (environment && revisions.status === "loading") return <ViewState kind="loading" />;
  if (environment && !current)
    return (
      <StatusView
        status={revisions.status}
        error={revisions.error}
        onRetry={() => void revisions.reload()}
      >
        <ViewState kind="error" message="The environment's active revision could not be loaded." />
      </StatusView>
    );
  const before: EnvironmentSettings | null =
    environment && current
      ? {
          name: environment.name,
          baseUrl: current.targetOrigins[0] ?? "",
          networkProfile: current.networkProfile,
          production: current.production,
        }
      : null;
  return <EnvironmentForm key={current?.id ?? "new"} {...props} before={before} />;
}

function EnvironmentForm(props: EditorProps & { before: EnvironmentSettings | null }): ReactNode {
  const { before, environment, project } = props;
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const formId = useId();
  const [name, setName] = useState(before?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(before?.baseUrl ?? "");
  const [networkProfile, setNetworkProfile] = useState(before?.networkProfile ?? "public");
  const [production, setProduction] = useState(before?.production ?? false);
  const [issues, setIssues] = useState<readonly FieldIssue[]>([]);
  const [summaryKey, setSummaryKey] = useState(0);
  const target = parseTarget(baseUrl);
  const after: EnvironmentSettings = {
    name: name.trim(),
    baseUrl: target ?? baseUrl,
    networkProfile,
    production,
  };
  const changed =
    before === null ||
    before.name !== after.name ||
    (parseTarget(before.baseUrl) ?? before.baseUrl) !== after.baseUrl ||
    before.networkProfile !== after.networkProfile ||
    before.production !== after.production;

  function validate(): readonly FieldIssue[] {
    const found: FieldIssue[] = [];
    if (name.trim() === "")
      found.push({ fieldId: `${formId}-name`, message: "Enter a name for the environment." });
    if (target === null)
      found.push({
        fieldId: `${formId}-url`,
        message: "Enter a base URL that starts with http:// or https://.",
      });
    return found;
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    const found = validate();
    setIssues(found);
    setSummaryKey((value) => value + 1);
  }

  async function save(idempotencyKey: string): Promise<void> {
    const found = validate();
    setIssues(found);
    if (found.length > 0) throw new Error("Fix the highlighted fields first.");
    const base = target ?? baseUrl;
    if (environment === null) {
      await api("POST", `/projects/${encodeURIComponent(project.id)}/environments`, {
        body: { name: after.name, baseUrl: base, networkProfile, production },
        idempotencyKey,
      });
    } else {
      const patch: Record<string, unknown> = {};
      if (before?.name !== after.name) patch.name = after.name;
      if (before?.baseUrl !== after.baseUrl) patch.baseUrl = base;
      if (before?.networkProfile !== after.networkProfile) patch.networkProfile = networkProfile;
      if (before?.production !== after.production) patch.production = production;
      await api("PATCH", `/environments/${encodeURIComponent(environment.id)}`, {
        body: patch,
        ifMatch: environment.version,
        idempotencyKey,
      });
    }
    props.onReloadList();
    props.onDone();
  }

  const nameIssue = issues.find((issue) => issue.fieldId === `${formId}-name`);
  const urlIssue = issues.find((issue) => issue.fieldId === `${formId}-url`);
  return (
    <form
      noValidate
      onSubmit={onSubmit}
      aria-label={environment ? "Edit environment" : "New environment"}
      className="settings-form"
    >
      <h3>{environment ? `Edit environment` : "New environment"}</h3>
      <ErrorSummary key={summaryKey} issues={issues} />
      <ErrorBanner error={saveError} onReload={props.onReloadList} />
      <FormField id={`${formId}-name`} label="Name" required error={nameIssue?.message ?? null}>
        {(control) => (
          <input
            {...control}
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </FormField>
      <FormField
        id={`${formId}-url`}
        label="Base URL"
        required
        hint="The origin the tests run against, for example https://staging.example.com."
        error={urlIssue?.message ?? null}
      >
        {(control) => (
          <input
            {...control}
            type="url"
            inputMode="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        )}
      </FormField>
      <FormField label="Network access" hint="Which addresses runs on this environment may reach.">
        {(control) => (
          <select
            {...control}
            value={networkProfile}
            onChange={(event) => setNetworkProfile(event.target.value)}
          >
            {networkProfiles.map((profile) => (
              <option key={profile.value} value={profile.value}>
                {profile.label}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={production}
            onChange={(event) => setProduction(event.target.checked)}
          />{" "}
          Production environment
        </label>
        <p className="hint">Write actions need an approval bound to the environment revision.</p>
      </div>
      <ImpactPanel impacts={environmentImpact(before, after)} />
      <div className="actions">
        <ConfirmButton
          label={environment ? "Save environment" : "Create environment"}
          tone="primary"
          disabledReason={changed ? null : "Nothing changed yet."}
          beforeOpen={() => {
            const found = validate();
            setIssues(found);
            setSummaryKey((value) => value + 1);
            return found.length === 0;
          }}
          dialog={{
            title: environment ? "Save environment changes?" : "Create environment?",
            description:
              "Review the impact panel on the page. Saving records a new environment revision; recorded runs are not recomputed.",
            context: [
              { label: "Workspace", value: props.workspaceName },
              { label: "Project", value: project.name },
              { label: "Environment", value: after.name === "" ? "(unnamed)" : after.name },
              { label: "Target", value: after.baseUrl },
            ],
            confirmLabel: environment ? "Save changes" : "Create environment",
          }}
          onConfirm={async (key) => {
            setSaveError(null);
            try {
              await save(key);
            } catch (failure) {
              if (failure instanceof ApiError) setSaveError(failure);
              throw failure;
            }
          }}
          successMessage={environment ? "Environment saved" : "Environment created"}
        />
        <button type="button" className="button secondary" onClick={props.onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function EnvironmentsSection({
  project,
  projectEtag,
  me,
  reloadProject,
}: {
  project: ProjectSummary;
  projectEtag: string | null;
  me: Me;
  reloadProject: () => Promise<void>;
}): ReactNode {
  const environments = usePaged<Environment>(
    `/projects/${encodeURIComponent(project.id)}/environments`,
  );
  const [editing, setEditing] = useState<Environment | "new" | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const wasEditing = useRef(false);
  // The editor and its dialog leave the page when saving ends; focus returns to the section so
  // keyboard users keep their place instead of landing on <body>.
  useEffect(() => {
    if (editing === null && wasEditing.current) heading.current?.focus();
    wasEditing.current = editing !== null;
  }, [editing]);
  const canWrite = me.permissions.write;
  const writeReason = canWrite
    ? null
    : "Your role cannot change environments (write access is required).";

  const columns: Column<Environment>[] = [
    {
      key: "name",
      header: "Environment",
      sortValue: (item) => item.name.toLowerCase(),
      render: (item) => <UntrustedText value={item.name} maxLength={120} />,
    },
    {
      key: "state",
      header: "State",
      sortValue: (item) => (item.archivedAt ? 1 : 0),
      render: (item) => (
        <>
          {item.archivedAt ? "Archived" : "Active"}
          {project.defaultEnvironmentId === item.id ? " · Default" : ""}
        </>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (item) =>
        item.archivedAt || !canWrite ? (
          "—"
        ) : (
          <span className="row-actions">
            <button
              type="button"
              className="button secondary"
              aria-disabled={!canWrite}
              onClick={() => canWrite && setEditing(item)}
            >
              Edit<span className="visually-hidden"> {item.name}</span>
            </button>
            {project.defaultEnvironmentId === item.id ? null : (
              <ConfirmButton
                label="Make default"
                subject={item.name}
                tone="secondary"
                dialog={{
                  title: "Make this the default environment?",
                  description:
                    "New runs for this project use the default environment unless one is chosen.",
                  context: [
                    { label: "Workspace", value: me.workspace.name },
                    { label: "Project", value: project.name },
                    { label: "Environment", value: item.name },
                  ],
                  confirmLabel: "Make default",
                }}
                onConfirm={async (key) => {
                  await api(
                    "POST",
                    `/projects/${encodeURIComponent(project.id)}/default-environment`,
                    {
                      body: { environmentId: item.id },
                      ifMatch: projectEtag,
                      idempotencyKey: key,
                    },
                  );
                  await reloadProject();
                }}
              />
            )}
            {project.defaultEnvironmentId === item.id ? null : (
              <ConfirmButton
                label="Archive"
                subject={item.name}
                tone="danger"
                dialog={{
                  title: "Archive this environment?",
                  description:
                    "Archived environments cannot be edited or used for new runs. Recorded runs keep their revision.",
                  context: [
                    { label: "Workspace", value: me.workspace.name },
                    { label: "Project", value: project.name },
                    { label: "Environment", value: item.name },
                  ],
                  confirmLabel: "Archive environment",
                  destructive: true,
                }}
                onConfirm={async (key) => {
                  await api("DELETE", `/environments/${encodeURIComponent(item.id)}`, {
                    ifMatch: item.version,
                    idempotencyKey: key,
                  });
                  await environments.reload();
                }}
              />
            )}
          </span>
        ),
    },
  ];
  return (
    <section aria-labelledby="environments-heading" className="settings-section">
      <h2 id="environments-heading" tabIndex={-1} ref={heading}>
        Environments
      </h2>
      <p className="hint">
        Each save records a new immutable environment revision. Recorded runs keep the revision they
        ran against.
      </p>
      <StatusView
        status={environments.status}
        error={environments.error}
        onRetry={() => void environments.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No environments"
            message="This project has no environments yet."
          />
        }
      >
        <SearchableTable
          caption="Environments"
          columns={columns}
          rows={environments.items}
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
              match: (item, value) => (value === "archived") === (item.archivedAt !== null),
            },
          ]}
          empty={
            <ViewState
              kind="empty"
              title="No environments"
              message="This project has no environments yet."
            />
          }
          pager={{
            hasMore: environments.hasMore,
            loading: environments.loadingMore,
            onLoadMore: () => void environments.loadMore(),
          }}
        />
      </StatusView>
      <p>
        <button
          type="button"
          className="button"
          aria-disabled={!canWrite}
          aria-describedby={writeReason ? "env-write-reason" : undefined}
          onClick={() => canWrite && setEditing("new")}
        >
          New environment
        </button>
      </p>
      {writeReason ? (
        <p className="hint" id="env-write-reason">
          {writeReason}
        </p>
      ) : null}
      {editing ? (
        <EnvironmentEditor
          key={editing === "new" ? "new" : editing.id}
          project={project}
          projectEtag={projectEtag}
          workspaceName={me.workspace.name}
          environment={editing === "new" ? null : editing}
          onDone={() => setEditing(null)}
          onReloadList={() => void environments.reload()}
        />
      ) : null}
    </section>
  );
}
