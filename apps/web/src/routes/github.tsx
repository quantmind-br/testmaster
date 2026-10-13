import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, api } from "../api";
import { type Column, DataTable } from "../components/data-table";
import { ErrorSummary, type FieldIssue, FormField } from "../components/form";
import { StatusBadge } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged } from "../hooks/use-resource";
import { NotFoundPage } from "./not-found";
import type { PortalRoute } from "./types";

interface IntegrationSummary {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly state: string;
  readonly projectIds: readonly string[];
  readonly consent: { readonly scopes: readonly string[] };
  readonly adapterStatus: string;
  readonly lastTest: {
    readonly deliveryId: string;
    readonly state: string;
    readonly at: string;
  } | null;
}

interface RepositoryView {
  readonly repositoryId: string;
  readonly fullName: string;
  readonly private: boolean;
  readonly granted: boolean;
  readonly enabled: boolean;
  readonly projectId: string | null;
  readonly includeDrafts: boolean;
  readonly forkPolicy: "deny" | "fixture-only";
  readonly baseEnvironmentId: string | null;
  readonly fixtureEnvironmentId: string | null;
  readonly previewEnvironmentPattern: string;
  readonly previewProvider: "github-deployments" | "manual";
}

interface InstallationView {
  readonly id: string;
  readonly installationId: string;
  readonly accountLogin: string;
  readonly accountType: string;
  readonly repositorySelection: string;
  readonly state: string;
  readonly revokedReason: string | null;
  readonly permissions: Readonly<Record<string, string>>;
  readonly repositories: readonly RepositoryView[];
}

interface PullView {
  readonly id: string;
  readonly repositoryFullName: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly fork: boolean;
  readonly draft: boolean;
  readonly state: string;
  readonly reasonCode: string | null;
  readonly previewUrl: string | null;
  readonly batchId: string | null;
  readonly supersededBy: string | null;
  readonly gate: string | null;
}

interface CheckView {
  readonly id: string;
  readonly repositoryFullName: string;
  readonly headSha: string;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly state: string;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
}

interface NamedView {
  readonly id: string;
  readonly name: string;
}

const short = (sha: string): string => sha.slice(0, 7);

/** Runs one action at a time: a second call while one is in flight is dropped, never queued. */
function useAction(): {
  readonly pending: boolean;
  readonly error: ApiError | Error | null;
  run(action: () => Promise<void>): Promise<void>;
} {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  return {
    pending,
    error,
    async run(action) {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      setError(null);
      try {
        await action();
      } catch (caught) {
        setError(caught instanceof Error ? caught : new Error("The action failed."));
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
  };
}

function ActionError({ error }: { error: Error | null }): ReactNode {
  if (!error) return null;
  return (
    <p role="alert" className="banner tone-danger">
      <UntrustedText value={error.message} maxLength={300} />
      {error instanceof ApiError ? ` (${error.code})` : ""}
    </p>
  );
}

const integrationColumns: Column<IntegrationSummary>[] = [
  {
    key: "name",
    header: "Integration",
    render: (item) => (
      <Link to={`/integrations/github/${encodeURIComponent(item.id)}`}>
        <UntrustedText value={item.name} maxLength={80} />
      </Link>
    ),
  },
  { key: "state", header: "State", render: (item) => <StatusBadge status={item.state} /> },
  {
    key: "adapter",
    header: "Adapter",
    render: (item) => <StatusBadge status={item.adapterStatus} />,
  },
];

function GithubIntegrations(): ReactNode {
  usePageTitle("GitHub integrations");
  const integrations = usePaged<IntegrationSummary>("/integrations");
  const github = integrations.items.filter((item) => item.provider === "github");
  return (
    <>
      <h1>GitHub integrations</h1>
      <p>
        Create the App with <code>testmaster integrations github setup</code>, then install it on
        the repositories to test. Nothing runs for a repository until you enable it here.
      </p>
      <StatusView
        status={integrations.status}
        error={integrations.error}
        onRetry={() => void integrations.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No GitHub App yet"
            message="Run the setup command to create the App and store its credentials."
          />
        }
      >
        {github.length === 0 ? (
          <ViewState
            kind="empty"
            title="No GitHub App yet"
            message="Run the setup command to create the App and store its credentials."
          />
        ) : (
          <DataTable
            caption="GitHub integrations"
            columns={integrationColumns}
            rows={github}
            rowKey={(item) => item.id}
          />
        )}
      </StatusView>
    </>
  );
}

function ConsentPanel({ integration }: { integration: IntegrationSummary }): ReactNode {
  const action = useAction();
  const [receipt, setReceipt] = useState<{ deliveryId: string; state: string } | null>(null);
  return (
    <section aria-labelledby="gh-consent">
      <h2 id="gh-consent">Consent and test delivery</h2>
      <p>This integration was granted these scopes. Anything outside this list is refused.</p>
      <ul aria-label="Consented scopes">
        {integration.consent.scopes.map((scope) => (
          <li key={scope}>
            <code>{scope}</code>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="button secondary"
        aria-disabled={action.pending}
        onClick={() =>
          void action.run(async () => {
            const result = await api<{ deliveryId: string; state: string }>(
              "POST",
              `/integrations/${encodeURIComponent(integration.id)}/test`,
            );
            setReceipt(result.data);
          })
        }
      >
        Send test delivery
      </button>
      <ActionError error={action.error} />
      <p role="status">
        {receipt ? (
          <>
            Test delivery <code>{receipt.deliveryId}</code> finished as{" "}
            <strong>{receipt.state}</strong>. It was a labelled test and does not represent a GitHub
            event.
          </>
        ) : integration.lastTest ? (
          <>
            Last test delivery finished as <strong>{integration.lastTest.state}</strong> at{" "}
            <time dateTime={integration.lastTest.at}>{integration.lastTest.at}</time>.
          </>
        ) : (
          "No test delivery has been sent."
        )}
      </p>
    </section>
  );
}

function RepositoryForm(props: {
  readonly integrationId: string;
  readonly integrationProjects: readonly string[];
  readonly repository: RepositoryView;
  readonly onSaved: () => void;
}): ReactNode {
  const { repository } = props;
  const action = useAction();
  const [enabled, setEnabled] = useState(repository.enabled);
  const [projectId, setProjectId] = useState(
    repository.projectId ?? props.integrationProjects[0] ?? "",
  );
  const [baseEnvironmentId, setBaseEnvironmentId] = useState(repository.baseEnvironmentId ?? "");
  const [forkPolicy, setForkPolicy] = useState(repository.forkPolicy);
  const [fixtureEnvironmentId, setFixtureEnvironmentId] = useState(
    repository.fixtureEnvironmentId ?? "",
  );
  const [includeDrafts, setIncludeDrafts] = useState(repository.includeDrafts);
  const [pattern, setPattern] = useState(repository.previewEnvironmentPattern);
  const [previewProvider, setPreviewProvider] = useState(repository.previewProvider);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [saved, setSaved] = useState(false);
  const environments = usePaged<NamedView>(
    `/projects/${encodeURIComponent(projectId || "none")}/environments`,
  );
  const prefix = `repo-${repository.repositoryId}`;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaved(false);
    const found: FieldIssue[] = [];
    if (enabled && !projectId)
      found.push({
        fieldId: `${prefix}-project`,
        message: "Choose the project this repository runs.",
      });
    if (enabled && !baseEnvironmentId)
      found.push({
        fieldId: `${prefix}-env`,
        message: "Choose the environment copied into each preview.",
      });
    if (forkPolicy === "fixture-only" && !fixtureEnvironmentId)
      found.push({
        fieldId: `${prefix}-fixture`,
        message: "Fixture-only fork runs need a secret-free fixture environment.",
      });
    setIssues(found);
    setAttempt((value) => value + 1);
    if (found.length > 0) return;
    await action.run(async () => {
      await api(
        "PATCH",
        `/integrations/${encodeURIComponent(props.integrationId)}/github/repositories/${encodeURIComponent(repository.repositoryId)}`,
        {
          body: {
            enabled,
            includeDrafts,
            forkPolicy,
            ...(projectId ? { projectId } : {}),
            ...(baseEnvironmentId ? { baseEnvironmentId } : {}),
            ...(forkPolicy === "fixture-only" ? { fixtureEnvironmentId } : {}),
            preview: { provider: previewProvider, environmentPattern: pattern },
          },
        },
      );
      setSaved(true);
      props.onSaved();
    });
  }
  const issueFor = (fieldId: string): string | null =>
    issues.find((issue) => issue.fieldId === fieldId)?.message ?? null;
  return (
    <form
      aria-label={`Settings for ${repository.fullName}`}
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <ErrorSummary key={attempt} issues={issues} />
      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />{" "}
          Run pull requests of {repository.fullName}
        </label>
      </div>
      <FormField label="Project" id={`${prefix}-project`} error={issueFor(`${prefix}-project`)}>
        {(control) => (
          <select
            {...control}
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Not selected</option>
            {props.integrationProjects.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField
        label="Base environment"
        id={`${prefix}-env`}
        error={issueFor(`${prefix}-env`)}
        hint="Locale, timezone and policy are copied into every ephemeral preview environment."
      >
        {(control) => (
          <select
            {...control}
            value={baseEnvironmentId}
            onChange={(event) => setBaseEnvironmentId(event.target.value)}
          >
            <option value="">Not selected</option>
            {environments.items.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField
        label="Pull requests from forks"
        id={`${prefix}-fork`}
        hint="A fork never reaches a secret, and a fork run can never satisfy the required gate."
      >
        {(control) => (
          <select
            {...control}
            value={forkPolicy}
            onChange={(event) =>
              setForkPolicy(event.target.value === "fixture-only" ? "fixture-only" : "deny")
            }
          >
            <option value="deny">Deny: run nothing</option>
            <option value="fixture-only">Fixture only: run against a secret-free fixture</option>
          </select>
        )}
      </FormField>
      {forkPolicy === "fixture-only" ? (
        <FormField
          label="Fixture environment"
          id={`${prefix}-fixture`}
          error={issueFor(`${prefix}-fixture`)}
        >
          {(control) => (
            <select
              {...control}
              value={fixtureEnvironmentId}
              onChange={(event) => setFixtureEnvironmentId(event.target.value)}
            >
              <option value="">Not selected</option>
              {environments.items.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
      ) : null}
      <FormField
        label="Preview provider"
        id={`${prefix}-provider`}
        hint="Deployment statuses from GitHub, or a preview URL you attest below."
      >
        {(control) => (
          <select
            {...control}
            value={previewProvider}
            onChange={(event) =>
              setPreviewProvider(event.target.value === "manual" ? "manual" : "github-deployments")
            }
          >
            <option value="github-deployments">
              GitHub deployment statuses (Vercel, Netlify, Render)
            </option>
            <option value="manual">Manual: attest the preview URL</option>
          </select>
        )}
      </FormField>
      <FormField
        label="Preview environment pattern"
        id={`${prefix}-pattern`}
        hint="Glob matched against the deployment environment name, for example preview/*."
      >
        {(control) => (
          <input
            {...control}
            type="text"
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
          />
        )}
      </FormField>
      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={includeDrafts}
            onChange={(event) => setIncludeDrafts(event.target.checked)}
          />{" "}
          Include draft pull requests
        </label>
      </div>
      <ActionError error={action.error} />
      <button type="submit" className="button" aria-disabled={action.pending}>
        Save settings for {repository.fullName}
      </button>
      <p role="status">{saved ? `Settings for ${repository.fullName} were saved.` : ""}</p>
    </form>
  );
}

function InstallationsPanel({ integration }: { integration: IntegrationSummary }): ReactNode {
  const installations = usePaged<InstallationView>(
    `/integrations/${encodeURIComponent(integration.id)}/github/installations`,
  );
  return (
    <section aria-labelledby="gh-installations">
      <h2 id="gh-installations">Installations and repositories</h2>
      <StatusView
        status={installations.status}
        error={installations.error}
        onRetry={() => void installations.reload()}
        empty={
          <ViewState
            kind="empty"
            title="Not installed"
            message="Install the App on the repositories to test. They appear here as soon as GitHub tells us."
          />
        }
      >
        {installations.items.map((installation) => (
          <article
            key={installation.id}
            aria-label={`Installation of ${installation.accountLogin}`}
          >
            <h3>
              <UntrustedText value={installation.accountLogin} maxLength={80} />{" "}
              <StatusBadge status={installation.state} />
            </h3>
            <p>
              {installation.accountType} account,{" "}
              {installation.repositorySelection === "all"
                ? "all repositories"
                : "selected repositories"}
              .{installation.revokedReason ? ` Revoked: ${installation.revokedReason}.` : ""}
            </p>
            <p>
              Permissions:{" "}
              {Object.entries(installation.permissions)
                .map(([name, level]) => `${name}: ${level}`)
                .join(", ") || "none"}
            </p>
            {installation.repositories.length === 0 ? (
              <ViewState
                kind="empty"
                title="No repositories"
                message="GitHub has not granted any repository to this installation."
              />
            ) : (
              installation.repositories.map((repository) =>
                installation.state !== "active" || !repository.granted ? (
                  <p key={repository.repositoryId}>
                    <UntrustedText value={repository.fullName} maxLength={120} /> cannot be
                    configured:{" "}
                    {installation.state !== "active"
                      ? "the installation is no longer active."
                      : "GitHub no longer grants this repository."}
                  </p>
                ) : (
                  <details key={repository.repositoryId} open={repository.enabled}>
                    <summary>
                      <UntrustedText value={repository.fullName} maxLength={120} />{" "}
                      {repository.enabled ? "(enabled)" : "(disabled)"}
                      {repository.private ? " private" : ""}
                    </summary>
                    <RepositoryForm
                      integrationId={integration.id}
                      integrationProjects={integration.projectIds}
                      repository={repository}
                      onSaved={() => void installations.reload()}
                    />
                  </details>
                ),
              )
            )}
          </article>
        ))}
      </StatusView>
    </section>
  );
}

const pullColumns: Column<PullView>[] = [
  {
    key: "pr",
    header: "Pull request",
    render: (pull) => (
      <>
        <UntrustedText value={pull.repositoryFullName} maxLength={100} /> #{pull.prNumber}
        {pull.fork ? " (fork)" : ""}
        {pull.draft ? " (draft)" : ""}
      </>
    ),
  },
  { key: "head", header: "Head", render: (pull) => <code>{short(pull.headSha)}</code> },
  {
    key: "state",
    header: "State",
    render: (pull) => (
      <>
        <StatusBadge status={pull.state} />
        {pull.reasonCode ? <span> {pull.reasonCode}</span> : null}
        {pull.supersededBy ? <span> by {short(pull.supersededBy)}</span> : null}
      </>
    ),
  },
  {
    key: "gate",
    header: "Gate",
    render: (pull) => (pull.gate ? <StatusBadge status={pull.gate} /> : "Not decided"),
  },
  {
    key: "preview",
    header: "Preview",
    render: (pull) => <UntrustedText value={pull.previewUrl} maxLength={120} fallback="Waiting" />,
  },
  {
    key: "result",
    header: "Result",
    render: (pull) =>
      pull.batchId ? (
        <Link to={`/batches/${encodeURIComponent(pull.batchId)}`}>Open batch {pull.batchId}</Link>
      ) : (
        "No run yet"
      ),
  },
];

function PullsPanel({ integration }: { integration: IntegrationSummary }): ReactNode {
  const pulls = usePaged<PullView>(
    `/integrations/${encodeURIComponent(integration.id)}/github/pulls`,
  );
  return (
    <section aria-labelledby="gh-pulls">
      <h2 id="gh-pulls">Pull requests</h2>
      <button type="button" className="button secondary" onClick={() => void pulls.reload()}>
        Refresh pull requests
      </button>
      <StatusView
        status={pulls.status}
        error={pulls.error}
        onRetry={() => void pulls.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No pull requests"
            message="Pull requests of enabled repositories appear here."
          />
        }
      >
        <DataTable
          caption="Pull requests"
          columns={pullColumns}
          rows={pulls.items}
          rowKey={(pull) => pull.id}
          pager={{
            hasMore: pulls.hasMore,
            loading: pulls.status === "loading",
            onLoadMore: () => void pulls.loadMore(),
          }}
        />
      </StatusView>
    </section>
  );
}

function ChecksPanel({ integration }: { integration: IntegrationSummary }): ReactNode {
  const checks = usePaged<CheckView>(
    `/integrations/${encodeURIComponent(integration.id)}/github/checks`,
  );
  const action = useAction();
  const [notice, setNotice] = useState("");
  const columns: Column<CheckView>[] = [
    {
      key: "check",
      header: "Check",
      render: (check) => (
        <>
          {check.name} on <code>{short(check.headSha)}</code>
        </>
      ),
    },
    {
      key: "published",
      header: "Published",
      render: (check) => <StatusBadge status={check.conclusion ?? check.status} />,
    },
    {
      key: "delivery",
      header: "Delivery",
      render: (check) => (
        <>
          <StatusBadge status={check.state} /> after {check.attempts} attempt
          {check.attempts === 1 ? "" : "s"}
          {check.lastError ? <span> {check.lastError}</span> : null}
          {check.nextAttemptAt ? (
            <>
              {" "}
              next <time dateTime={check.nextAttemptAt}>{check.nextAttemptAt}</time>
            </>
          ) : null}
        </>
      ),
    },
    {
      key: "actions",
      header: "Action",
      render: (check) =>
        check.state === "dead_letter" ? (
          <button
            type="button"
            className="button secondary"
            aria-disabled={action.pending}
            onClick={() =>
              void action.run(async () => {
                await api(
                  "POST",
                  `/integrations/${encodeURIComponent(integration.id)}/github/checks/${encodeURIComponent(check.id)}/retry`,
                );
                await checks.reload();
                setNotice(`Delivery of ${check.name} on ${short(check.headSha)} was queued again.`);
              })
            }
          >
            Retry delivery of {check.name} on {short(check.headSha)}
          </button>
        ) : (
          "None"
        ),
    },
  ];
  return (
    <section aria-labelledby="gh-checks">
      <h2 id="gh-checks">Checks published to GitHub</h2>
      <p>A delivery problem never changes a verdict: the Run and its gate stay as measured.</p>
      <ActionError error={action.error} />
      <p role="status">{notice}</p>
      <StatusView
        status={checks.status}
        error={checks.error}
        onRetry={() => void checks.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No checks yet"
            message="Checks appear when a pull request is first seen."
          />
        }
      >
        <DataTable
          caption="Checks published to GitHub"
          columns={columns}
          rows={checks.items}
          rowKey={(check) => check.id}
          pager={{
            hasMore: checks.hasMore,
            loading: checks.status === "loading",
            onLoadMore: () => void checks.loadMore(),
          }}
        />
      </StatusView>
    </section>
  );
}

function ManualPreview({ integration }: { integration: IntegrationSummary }): ReactNode {
  const installations = usePaged<InstallationView>(
    `/integrations/${encodeURIComponent(integration.id)}/github/installations`,
  );
  const repositories = installations.items.flatMap((installation) =>
    installation.state === "active"
      ? installation.repositories.filter((repository) => repository.granted)
      : [],
  );
  const action = useAction();
  const [repositoryId, setRepositoryId] = useState("");
  const [prNumber, setPrNumber] = useState("");
  const [headSha, setHeadSha] = useState("");
  const [url, setUrl] = useState("");
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const issueFor = (fieldId: string): string | null =>
    issues.find((issue) => issue.fieldId === fieldId)?.message ?? null;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setDone(null);
    const found: FieldIssue[] = [];
    if (!repositoryId)
      found.push({ fieldId: "preview-repository", message: "Choose a repository." });
    if (!/^[1-9][0-9]*$/u.test(prNumber))
      found.push({ fieldId: "preview-pr", message: "Enter the pull request number." });
    if (!/^[0-9a-f]{40}$/u.test(headSha))
      found.push({ fieldId: "preview-sha", message: "Enter the full 40-character head commit." });
    if (!/^https:\/\//u.test(url))
      found.push({ fieldId: "preview-url", message: "Enter an https:// preview URL." });
    setIssues(found);
    setAttempt((value) => value + 1);
    if (found.length > 0) return;
    await action.run(async () => {
      const result = await api<{ state: string }>("POST", "/preview-deployments", {
        body: {
          integrationId: integration.id,
          repositoryId,
          prNumber: Number(prNumber),
          headSha,
          url,
        },
      });
      setDone(`Preview recorded; the pull request is now ${result.data.state}.`);
    });
  }
  return (
    <section aria-labelledby="gh-preview">
      <h2 id="gh-preview">Manual preview</h2>
      <p>
        For repositories that use the manual preview provider, attest the preview URL of a pull
        request head. The URL still has to pass the network policy of the project.
      </p>
      <form
        aria-label="Record a manual preview"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <ErrorSummary key={attempt} issues={issues} />
        <FormField
          label="Repository"
          id="preview-repository"
          error={issueFor("preview-repository")}
        >
          {(control) => (
            <select
              {...control}
              value={repositoryId}
              onChange={(event) => setRepositoryId(event.target.value)}
            >
              <option value="">Not selected</option>
              {repositories.map((repository) => (
                <option key={repository.repositoryId} value={repository.repositoryId}>
                  {repository.fullName}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Pull request number" id="preview-pr" error={issueFor("preview-pr")}>
          {(control) => (
            <input
              {...control}
              type="text"
              inputMode="numeric"
              value={prNumber}
              onChange={(event) => setPrNumber(event.target.value)}
            />
          )}
        </FormField>
        <FormField label="Head commit" id="preview-sha" error={issueFor("preview-sha")}>
          {(control) => (
            <input
              {...control}
              type="text"
              value={headSha}
              onChange={(event) => setHeadSha(event.target.value.trim())}
            />
          )}
        </FormField>
        <FormField label="Preview URL" id="preview-url" error={issueFor("preview-url")}>
          {(control) => (
            <input
              {...control}
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value.trim())}
            />
          )}
        </FormField>
        <ActionError error={action.error} />
        <button type="submit" className="button" aria-disabled={action.pending}>
          Record preview
        </button>
        <p role="status">{done ?? ""}</p>
      </form>
    </section>
  );
}

function GithubIntegrationPage(): ReactNode {
  const { integrationId = "" } = useParams();
  const integrations = usePaged<IntegrationSummary>("/integrations");
  const integration =
    integrations.items.find((item) => item.id === integrationId && item.provider === "github") ??
    null;
  const settled = integrations.status === "ready" || integrations.status === "empty";
  usePageTitle(integration?.name ?? "GitHub integration");
  // An unknown ID, another tenant's ID and a non-GitHub integration are the same page.
  if (settled && !integration && !integrations.hasMore) return <NotFoundPage />;
  return (
    <StatusView
      status={integrations.status}
      error={integrations.error}
      onRetry={() => void integrations.reload()}
    >
      {integration ? (
        <>
          <h1>
            <UntrustedText value={integration.name} maxLength={80} />{" "}
            <StatusBadge status={integration.state} />
          </h1>
          <p>
            <Link to="/integrations/github">All GitHub integrations</Link>
          </p>
          <ConsentPanel integration={integration} />
          <InstallationsPanel integration={integration} />
          <PullsPanel integration={integration} />
          <ChecksPanel integration={integration} />
          <ManualPreview integration={integration} />
        </>
      ) : null}
    </StatusView>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/integrations/github",
    title: "GitHub",
    element: <GithubIntegrations />,
    nav: { label: "GitHub", section: "Integrations" },
  },
  {
    path: "/integrations/github/:integrationId",
    title: "GitHub integration",
    element: <GithubIntegrationPage />,
  },
];
