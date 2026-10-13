import { type ReactNode, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { type Column, DataTable } from "../components/data-table";
import { ErrorSummary, type FieldIssue, FormField } from "../components/form";
import { useSelectContext } from "../components/portal-context";
import { StatusBadge } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged, useResource } from "../hooks/use-resource";
import { type Failure, toFailure } from "../lib/api-error";
import type { DiscoveryDetail, DiscoverySummary, ProjectRef } from "../lib/m4-types";
import { shortHash } from "../lib/onboarding";
import { NotFoundPage } from "./not-found";
import type { PortalRoute } from "./types";

const MAX_LISTED_FILES = 200;

/** What the server will reject for a diff, so the form can say so before sending. */
export function diffIssues(input: {
  scope: "codebase" | "diff";
  base: string;
  head: string;
  workingTree: boolean;
}): FieldIssue[] {
  if (input.scope !== "diff") return [];
  const issues: FieldIssue[] = [];
  if (!input.base.trim())
    issues.push({ fieldId: "discovery-base", message: "Enter the base commit or branch" });
  if (!input.head.trim() && !input.workingTree)
    issues.push({
      fieldId: "discovery-head",
      message: "Enter the head commit, or include the working tree",
    });
  return issues;
}

function NewDiscovery({ projectId }: { projectId: string }): ReactNode {
  const navigate = useNavigate();
  const [scope, setScope] = useState<"codebase" | "diff">("codebase");
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [workingTree, setWorkingTree] = useState(false);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const issueFor = (id: string) => issues.find((item) => item.fieldId === id)?.message ?? null;

  async function start(): Promise<void> {
    if (busy) return;
    const found = diffIssues({ scope, base, head, workingTree });
    setAttempt((value) => value + 1);
    setIssues(found);
    if (found.length > 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const budget: Record<string, unknown> = {};
      if (scope === "diff") {
        budget.base = base.trim();
        if (head.trim()) budget.head = head.trim();
        if (workingTree) budget.workingTree = true;
      }
      const sources = await api<{ items: { activeRevisionId: string | null }[] }>(
        "GET",
        `/projects/${encodeURIComponent(projectId)}/sources`,
        { query: { limit: 100 } },
      );
      const created = await api<{ id: string }>(
        "POST",
        `/projects/${encodeURIComponent(projectId)}/discovery`,
        {
          body: {
            projectId,
            sourceRevisionIds: sources.data.items.flatMap((item) =>
              item.activeRevisionId ? [item.activeRevisionId] : [],
            ),
            scope: [scope],
            budget,
          },
        },
      );
      navigate(
        `/projects/${encodeURIComponent(projectId)}/discovery/${encodeURIComponent(created.data.id)}`,
      );
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="New discovery">
      <h2>Preview a discovery</h2>
      <p className="hint">
        A discovery reads the repository and your sources. It writes nothing to your code and never
        claims the whole application was understood.
      </p>
      <ErrorSummary key={attempt} issues={issues} />
      <fieldset>
        <legend>Scope</legend>
        {(["codebase", "diff"] as const).map((value) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="discovery-scope"
              checked={scope === value}
              onChange={() => {
                setScope(value);
                setIssues([]);
              }}
            />{" "}
            {value === "codebase"
              ? "Full — the whole repository"
              : "Diff — only what changed between two points"}
          </label>
        ))}
      </fieldset>
      {scope === "diff" ? (
        <>
          <FormField
            label="Base"
            required
            id="discovery-base"
            error={issueFor("discovery-base")}
            hint="A commit SHA, tag or branch."
          >
            {(props) => (
              <input
                {...props}
                type="text"
                value={base}
                onChange={(event) => setBase(event.target.value)}
              />
            )}
          </FormField>
          <FormField
            label="Head"
            id="discovery-head"
            error={issueFor("discovery-head")}
            hint="A commit SHA, tag or branch. Leave empty to use the working tree."
          >
            {(props) => (
              <input
                {...props}
                type="text"
                value={head}
                onChange={(event) => setHead(event.target.value)}
              />
            )}
          </FormField>
          <label className="choice">
            <input
              type="checkbox"
              checked={workingTree}
              onChange={(event) => setWorkingTree(event.target.checked)}
            />{" "}
            Include uncommitted changes from the working tree
          </label>
        </>
      ) : null}
      {failure ? (
        <div className="banner tone-danger" role="alert" data-testid="discovery-failure">
          <p>
            {failure.code}: {failure.message}
          </p>
        </div>
      ) : null}
      <button type="button" className="button" aria-disabled={busy} onClick={() => void start()}>
        {busy ? "Discovering…" : "Run discovery"}
      </button>
    </section>
  );
}

function DiscoveryList(): ReactNode {
  const { projectId = "" } = useParams();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const project = useResource<ProjectRef>(base);
  const runs = usePaged<DiscoverySummary>(`${base}/discovery`);
  useSelectContext(project.data ? { id: project.data.id, name: project.data.name } : null);
  usePageTitle("Discovery");
  if (project.status === "not-found") return <NotFoundPage />;
  const columns: Column<DiscoverySummary>[] = [
    {
      key: "run",
      header: "Discovery",
      render: (run) => (
        <Link to={`${base}/discovery/${encodeURIComponent(run.id)}`}>
          <time dateTime={run.createdAt}>{run.createdAt}</time>
        </Link>
      ),
    },
    { key: "scope", header: "Scope", render: (run) => (run.scope === "diff" ? "Diff" : "Full") },
    {
      key: "range",
      header: "Base → head",
      render: (run) =>
        run.scope === "diff" ? (
          <code>
            {shortHash(run.baseSha)} →{" "}
            {run.includesWorkingTree ? "working tree" : shortHash(run.headSha)}
          </code>
        ) : (
          <code>{shortHash(run.headSha)}</code>
        ),
    },
    { key: "status", header: "Status", render: (run) => <StatusBadge status={run.status} /> },
    {
      key: "counts",
      header: "Found",
      render: (run) =>
        `${run.counts.scannedFiles} files, ${run.counts.endpoints} endpoints, ${run.counts.routes} routes; ${run.counts.skippedFiles} skipped`,
    },
  ];
  return (
    <>
      <h1>Discovery</h1>
      <StatusView
        status={runs.status}
        error={runs.error}
        onRetry={() => void runs.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No discovery yet"
            message="Run a discovery to see which files, endpoints and features TestMaster found."
          />
        }
      >
        <DataTable
          caption="Discovery runs, newest first"
          columns={columns}
          rows={runs.items}
          rowKey={(run) => run.id}
          pager={{
            hasMore: runs.hasMore,
            loading: runs.loadingMore,
            onLoadMore: () => void runs.loadMore(),
          }}
        />
      </StatusView>
      <NewDiscovery projectId={projectId} />
    </>
  );
}

interface RouteRow {
  readonly method: string;
  readonly path: string;
  readonly file: string;
  readonly line: number;
  readonly framework: string;
}
const routeColumns: Column<RouteRow>[] = [
  { key: "method", header: "Method", render: (row) => <code>{row.method}</code> },
  {
    key: "path",
    header: "Path",
    render: (row) => <UntrustedText value={row.path} maxLength={200} />,
  },
  {
    key: "file",
    header: "Declared in",
    render: (row) => (
      <>
        <UntrustedText value={row.file} maxLength={200} />:{row.line}
      </>
    ),
  },
  { key: "framework", header: "Framework", render: (row) => row.framework },
];

function FileList({ label, files }: { label: string; files: readonly string[] }): ReactNode {
  return (
    <details>
      <summary>
        {label} ({files.length})
      </summary>
      <ul>
        {files.slice(0, MAX_LISTED_FILES).map((file) => (
          <li key={file}>
            <UntrustedText value={file} maxLength={240} />
          </li>
        ))}
      </ul>
      {files.length > MAX_LISTED_FILES ? <p>Showing the first {MAX_LISTED_FILES}.</p> : null}
    </details>
  );
}

function DiscoveryDetailPage(): ReactNode {
  const { projectId = "", discoveryId = "" } = useParams();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const project = useResource<ProjectRef>(base);
  const detail = useResource<DiscoveryDetail>(`/discovery/${encodeURIComponent(discoveryId)}`);
  useSelectContext(project.data ? { id: project.data.id, name: project.data.name } : null);
  usePageTitle("Discovery preview");
  if (project.status === "not-found" || detail.status === "not-found") return <NotFoundPage />;
  const data = detail.data;
  const routeRows = (items: DiscoveryDetail["summary"]["routes"]): RouteRow[] =>
    items.map((item) => ({
      method: item.method,
      path: item.path,
      file: item.ref.path,
      line: item.ref.line,
      framework: item.framework,
    }));
  return (
    <StatusView status={detail.status} error={detail.error} onRetry={() => void detail.reload()}>
      {data ? (
        <>
          <h1>Discovery preview</h1>
          <p>
            <Link to={`${base}/discovery`}>Back to discovery runs</Link>
          </p>
          <div className="banner tone-warning" role="note" data-testid="coverage-statement">
            <span>
              Coverage is <strong>{data.summary.coverage}</strong>. TestMaster lists what it could
              parse and what it skipped; it does not claim the application is fully mapped.
            </span>
          </div>
          <dl className="context">
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.status} />
            </dd>
            <dt>Scope</dt>
            <dd>{data.diff ? "Diff" : "Full"}</dd>
            {data.diff ? (
              <>
                <dt>Base</dt>
                <dd>
                  <code data-testid="base-sha">{data.diff.baseSha}</code>
                </dd>
                <dt>Head</dt>
                <dd>
                  <code data-testid="head-sha">{data.diff.headSha}</code>
                  {data.diff.includeWorkingTree ? " plus uncommitted changes" : ""}
                </dd>
                <dt>Merge base</dt>
                <dd>
                  <code>{data.diff.mergeBase}</code>
                </dd>
              </>
            ) : (
              <>
                <dt>Commit</dt>
                <dd>
                  <code>{data.codeSnapshot.headSha ?? "not a git checkout"}</code>
                </dd>
              </>
            )}
            <dt>Tech stack</dt>
            <dd>{data.summary.techStack.map((item) => item.name).join(", ") || "none detected"}</dd>
          </dl>

          <section aria-label="Files">
            <h2>Files</h2>
            <p data-testid="file-counts">
              {data.summary.scannedFiles.length} scanned, {data.summary.skippedFiles.length}{" "}
              skipped.
            </p>
            <FileList label="Scanned files" files={data.summary.scannedFiles} />
            {data.summary.skippedFiles.length > 0 ? (
              <section aria-label="Skipped files" data-testid="skipped-files">
                <h3>Skipped files</h3>
                <ul>
                  {data.summary.skippedFiles.slice(0, MAX_LISTED_FILES).map((item) => (
                    <li key={`${item.path}-${item.reason}`}>
                      <UntrustedText value={item.path} maxLength={240} /> —{" "}
                      <code>{item.reason}</code>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {data.codeSnapshot.excludes.length > 0 ? (
              <p>
                Excluded by request: <code>{data.codeSnapshot.excludes.join(", ")}</code>
              </p>
            ) : null}
          </section>

          <section aria-label="Endpoints and routes">
            <h2>Endpoints</h2>
            <StatusView
              status={data.summary.endpoints.length === 0 ? "empty" : "ready"}
              error={null}
              empty={<p>No HTTP endpoint was found.</p>}
            >
              <DataTable
                caption="Endpoints"
                columns={routeColumns}
                rows={routeRows(data.summary.endpoints)}
                rowKey={(row) => `${row.method} ${row.path} ${row.file}:${row.line}`}
              />
            </StatusView>
            <h2>Routes</h2>
            <StatusView
              status={data.summary.routes.length === 0 ? "empty" : "ready"}
              error={null}
              empty={<p>No page route was found.</p>}
            >
              <DataTable
                caption="Routes"
                columns={routeColumns}
                rows={routeRows(data.summary.routes)}
                rowKey={(row) => `${row.method} ${row.path} ${row.file}:${row.line}`}
              />
            </StatusView>
          </section>

          <section aria-label="Features">
            <h2>Features</h2>
            {data.featureMap.features.length === 0 ? (
              <p>No feature was derived.</p>
            ) : (
              <ul>
                {data.featureMap.features.map((feature) => (
                  <li key={feature.id}>
                    <code>{feature.stableKey}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.diff ? (
            <section aria-label="Diff impact" data-testid="diff-impact">
              <h2>What changed</h2>
              <DataTable
                caption="Changed files"
                columns={[
                  { key: "status", header: "Change", render: (row) => row.status },
                  {
                    key: "path",
                    header: "File",
                    render: (row) => <UntrustedText value={row.path} maxLength={240} />,
                  },
                ]}
                rows={data.diff.changes}
                rowKey={(row) => `${row.status} ${row.path}`}
                empty={<p>No file changed between the two points.</p>}
              />
              <p>
                Auth code touched: <strong>{data.diff.impact.authTouched ? "yes" : "no"}</strong> ·
                critical smoke tests advised:{" "}
                <strong>{data.diff.impact.criticalSmoke ? "yes" : "no"}</strong>
              </p>
              <FileList
                label="Files used for the impact analysis"
                files={data.diff.impact.selectedFiles}
              />
              {data.diff.impact.excludedFiles.length > 0 ? (
                <section aria-label="Ignored files" data-testid="ignored-files">
                  <h3>Ignored files</h3>
                  <ul>
                    {data.diff.impact.excludedFiles.slice(0, MAX_LISTED_FILES).map((item) => (
                      <li key={`${item.path}-${item.reason}`}>
                        <UntrustedText value={item.path} maxLength={240} /> —{" "}
                        <code>{item.reason}</code>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {data.diff.impact.gaps.length > 0 ? (
                <section aria-label="Impact limits" data-testid="impact-limits">
                  <h3>Limits of this impact analysis</h3>
                  <ul>
                    {data.diff.impact.gaps.map((gap) => (
                      <li key={gap}>
                        <UntrustedText value={gap} maxLength={300} />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </section>
          ) : null}

          <section aria-label="Uncertainties" data-testid="uncertainties">
            <h2>Uncertainties</h2>
            {data.warnings.length + data.summary.warnings.length === 0 ? (
              <p>No parser warning was recorded.</p>
            ) : (
              <ul>
                {data.warnings.map((warning) => (
                  <li key={warning}>
                    <UntrustedText value={warning} maxLength={300} />
                  </li>
                ))}
                {data.summary.warnings.map((warning) => (
                  <li key={`${warning.path}-${warning.code}`}>
                    <code>{warning.code}</code>{" "}
                    <UntrustedText value={warning.path} maxLength={200} />:{" "}
                    <UntrustedText value={warning.message} maxLength={300} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </StatusView>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/projects/:projectId/discovery",
    title: "Discovery",
    element: <DiscoveryList />,
    projectNav: { label: "Discovery", order: 30 },
  },
  {
    path: "/projects/:projectId/discovery/:discoveryId",
    title: "Discovery preview",
    element: <DiscoveryDetailPage />,
  },
];
