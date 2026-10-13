import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { useMe } from "../components/app-shell";
import { ConfirmDialog } from "../components/confirm-dialog";
import { type Column, DataTable } from "../components/data-table";
import { ErrorSummary, type FieldIssue, FormField } from "../components/form";
import { StatusBadge } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged, useResource } from "../hooks/use-resource";
import { describeError, GuardedButton, TextField } from "./automation-shared";
import { NotFoundPage } from "./not-found";
import type { PortalRoute } from "./types";

interface Binding {
  readonly projectId: string;
  readonly environmentId: string;
  readonly filter?: { readonly tags?: readonly string[]; readonly nameContains?: string };
}
interface FixedMember {
  readonly testId: string;
  readonly revisionId: string;
  readonly environmentId: string;
}
type Selection =
  | { readonly kind: "dynamic"; readonly projects: readonly Binding[] }
  | { readonly kind: "fixed"; readonly members: readonly FixedMember[] };

interface SuiteView {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly state: "active" | "archived";
  readonly selection: Selection;
  readonly createdAt: string;
}
interface Member {
  readonly memberKey: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly testId: string;
  readonly testName: string;
  readonly revisionId: string;
  readonly revisionOrdinal: number;
  readonly environmentId: string;
  readonly environmentName: string;
}
interface Exclusion {
  readonly key: string;
  readonly projectId: string;
  readonly kind: string;
  readonly reasonCode: string;
  readonly message: string;
}
interface Mapping {
  readonly projectId: string;
  readonly projectName: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly targetOrigins: readonly string[];
  readonly secretRefs: readonly string[];
  readonly memberCount: number;
}
interface Expansion {
  readonly hash: string;
  readonly resolvedAt: string;
  readonly members: readonly Member[];
  readonly exclusions: readonly Exclusion[];
  readonly mapping: readonly Mapping[];
  readonly requiresConfirmation: readonly string[];
  readonly dispatchable: boolean;
}
interface Receipt {
  readonly batchId: string;
  readonly requested: number;
  readonly accepted: number;
  readonly notDispatched: readonly { readonly memberKey: string; readonly reasonCode: string }[];
}
interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly archivedAt: string | null;
}
interface EnvironmentSummary {
  readonly id: string;
  readonly name: string;
  readonly archivedAt: string | null;
}

const entryCount = (selection: Selection): number =>
  selection.kind === "dynamic" ? selection.projects.length : selection.members.length;

const suiteColumns: Column<SuiteView>[] = [
  {
    key: "name",
    header: "List",
    sortValue: (suite) => suite.name.toLowerCase(),
    render: (suite) => (
      <Link to={`/lists/${encodeURIComponent(suite.id)}`}>
        <UntrustedText value={suite.name} maxLength={120} />
      </Link>
    ),
  },
  {
    key: "kind",
    header: "Kind",
    render: (suite) => (suite.selection.kind === "dynamic" ? "Dynamic filter" : "Fixed snapshot"),
  },
  {
    key: "entries",
    header: "Entries",
    render: (suite) =>
      suite.selection.kind === "dynamic"
        ? `${entryCount(suite.selection)} projects`
        : `${entryCount(suite.selection)} pinned tests`,
  },
  { key: "state", header: "State", render: (suite) => <StatusBadge status={suite.state} /> },
];

function ListsPage(): ReactNode {
  usePageTitle("Lists");
  const me = useMe();
  const suites = usePaged<SuiteView>("/suites");
  return (
    <>
      <h1>Lists</h1>
      <p>
        A list is an ordered set of tests across projects, each project with its own explicit
        environment. Running a list freezes what it expands to.
      </p>
      <p>
        {me.permissions.write ? (
          <Link className="button" to="/lists/new">
            New list
          </Link>
        ) : (
          <GuardedButton
            label="New list"
            unavailable="Your role cannot create lists. Ask a maintainer."
            onClick={() => undefined}
          />
        )}
      </p>
      <StatusView
        status={suites.status}
        error={suites.error}
        onRetry={() => void suites.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No lists yet"
            message="Create a list to run tests from several projects together."
          />
        }
      >
        <DataTable
          caption="Lists"
          columns={suiteColumns}
          rows={suites.items}
          rowKey={(suite) => suite.id}
          pager={{
            hasMore: suites.hasMore,
            loading: suites.loadingMore,
            onLoadMore: () => void suites.loadMore(),
          }}
        />
      </StatusView>
    </>
  );
}

const memberColumns: Column<Member>[] = [
  {
    key: "project",
    header: "Project",
    render: (member) => <UntrustedText value={member.projectName} maxLength={80} />,
  },
  {
    key: "test",
    header: "Test",
    render: (member) => <UntrustedText value={member.testName} maxLength={120} />,
  },
  { key: "revision", header: "Revision", render: (member) => `#${member.revisionOrdinal}` },
  {
    key: "environment",
    header: "Environment",
    render: (member) => <UntrustedText value={member.environmentName} maxLength={80} />,
  },
];
const mappingColumns: Column<Mapping>[] = [
  {
    key: "project",
    header: "Project",
    render: (row) => <UntrustedText value={row.projectName} maxLength={80} />,
  },
  {
    key: "environment",
    header: "Environment",
    render: (row) => <UntrustedText value={row.environmentName} maxLength={80} />,
  },
  {
    key: "origins",
    header: "Allowed origins",
    render: (row) => (row.targetOrigins.length ? row.targetOrigins.join(", ") : "None"),
  },
  {
    key: "secrets",
    header: "Secrets used",
    render: (row) => `${row.secretRefs.length} (values are never shown)`,
  },
  { key: "tests", header: "Tests", render: (row) => String(row.memberCount) },
];
const exclusionColumns: Column<Exclusion>[] = [
  { key: "key", header: "Excluded", render: (item) => <code>{item.key}</code> },
  { key: "kind", header: "Why", render: (item) => item.kind.replaceAll("_", " ") },
  {
    key: "message",
    header: "Detail",
    render: (item) => <UntrustedText value={item.message} maxLength={200} />,
  },
];

function ListDetailPage(): ReactNode {
  const { suiteId = "" } = useParams();
  const me = useMe();
  const navigate = useNavigate();
  const path = `/suites/${encodeURIComponent(suiteId)}`;
  const suite = useResource<SuiteView>(path);
  const expansion = useResource<Expansion>(`${path}/expansion`);
  const [confirmRun, setConfirmRun] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [acceptSubset, setAcceptSubset] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  usePageTitle(suite.status === "not-found" ? "Not found" : (suite.data?.name ?? "List"));
  if (suite.status === "not-found") return <NotFoundPage />;
  const resolved = expansion.data;
  const partial = (resolved?.requiresConfirmation.length ?? 0) > 0;
  const executeBlock = !me.permissions.execute
    ? "Your role cannot run tests. Ask a maintainer or runner."
    : suite.data?.state === "archived"
      ? "An archived list cannot run."
      : resolved && !resolved.dispatchable && !partial
        ? "No test of this list can run right now."
        : partial && !acceptSubset
          ? "Part of this list is unavailable. Confirm the subset below to run the rest."
          : null;

  async function run(): Promise<void> {
    const result = await api<Receipt>("POST", `${path}/runs`, {
      body: {
        ...(partial && resolved ? { confirmedExclusions: resolved.requiresConfirmation } : {}),
        ...(resolved ? { expectedExpansionHash: resolved.hash } : {}),
      },
    });
    setReceipt(result.data);
    setConfirmRun(false);
    setAcceptSubset(false);
    void expansion.reload();
  }
  async function archive(): Promise<void> {
    await api("DELETE", path, { ifMatch: suite.etag });
    setConfirmArchive(false);
    navigate("/lists");
  }

  return (
    <StatusView status={suite.status} error={suite.error} onRetry={() => void suite.reload()}>
      {suite.data ? (
        <>
          <h1>
            <UntrustedText value={suite.data.name} maxLength={120} />
          </h1>
          {suite.data.description ? (
            <p>
              <UntrustedText value={suite.data.description} maxLength={500} />
            </p>
          ) : null}
          <dl className="context">
            <dt>Kind</dt>
            <dd>{suite.data.selection.kind === "dynamic" ? "Dynamic filter" : "Fixed snapshot"}</dd>
            <dt>State</dt>
            <dd>
              <StatusBadge status={suite.data.state} />
            </dd>
            <dt>Version</dt>
            <dd>{suite.data.version}</dd>
          </dl>
          {receipt ? (
            <div className="banner tone-success" role="status">
              <div>
                <p className="state-title">
                  Batch <code>{receipt.batchId}</code> admitted
                </p>
                <p>
                  {receipt.accepted} of {receipt.requested} tests were dispatched.
                  {receipt.notDispatched.length > 0
                    ? ` ${receipt.notDispatched.length} were not dispatched, so the gate stays failed.`
                    : ""}
                </p>
                {receipt.notDispatched.length > 0 ? (
                  <ul>
                    {receipt.notDispatched.map((item) => (
                      <li key={item.memberKey}>
                        <code>{item.memberKey}</code>: {item.reasonCode.replaceAll("_", " ")}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="actions">
            <GuardedButton
              label="Run list"
              unavailable={executeBlock}
              onClick={() => setConfirmRun(true)}
            />
            {me.permissions.write && suite.data.state === "active" ? (
              <Link className="button secondary" to={`/lists/${encodeURIComponent(suiteId)}/edit`}>
                Edit list
              </Link>
            ) : (
              <GuardedButton
                label="Edit list"
                tone="secondary"
                unavailable={
                  suite.data.state === "archived"
                    ? "An archived list cannot be edited."
                    : "Your role cannot edit lists."
                }
                onClick={() => undefined}
              />
            )}
            <GuardedButton
              label="Archive list"
              tone="danger"
              unavailable={
                !me.permissions.write
                  ? "Your role cannot archive lists."
                  : suite.data.state === "archived"
                    ? "This list is already archived."
                    : null
              }
              onClick={() => setConfirmArchive(true)}
            />
          </div>
          {partial ? (
            <div className="field">
              <label htmlFor="accept-subset">
                <input
                  id="accept-subset"
                  type="checkbox"
                  checked={acceptSubset}
                  onChange={(event) => setAcceptSubset(event.target.checked)}
                />{" "}
                Run only the available tests and record {resolved?.requiresConfirmation.length}{" "}
                excluded entries as not dispatched
              </label>
            </div>
          ) : null}
          <h2>What this list expands to now</h2>
          <StatusView
            status={expansion.status}
            error={expansion.error}
            onRetry={() => void expansion.reload()}
          >
            {resolved ? (
              <>
                {resolved.exclusions.length > 0 ? (
                  <ViewState
                    kind="partial"
                    message="Some entries are unavailable to you or to the target. A run needs your explicit confirmation of the subset, and its gate stays failed."
                  >
                    <DataTable
                      caption="Excluded entries"
                      columns={exclusionColumns}
                      rows={resolved.exclusions}
                      rowKey={(item) => item.key}
                    />
                  </ViewState>
                ) : null}
                <DataTable
                  caption="Tests that would run"
                  columns={memberColumns}
                  rows={resolved.members}
                  rowKey={(member) => member.memberKey}
                  empty={
                    <ViewState
                      kind="empty"
                      title="No test would run"
                      message="This list currently expands to nothing."
                    />
                  }
                />
                <DataTable
                  caption="Environment and credential mapping per project"
                  columns={mappingColumns}
                  rows={resolved.mapping}
                  rowKey={(row) => row.projectId}
                />
                <p>
                  Resolved <time dateTime={resolved.resolvedAt}>{resolved.resolvedAt}</time>. A run
                  freezes this expansion; editing the list later never changes a running batch.
                </p>
              </>
            ) : null}
          </StatusView>
          <ConfirmDialog
            open={confirmRun}
            title="Run this list"
            description="One batch is admitted with exactly the tests, revisions and environments shown on this page."
            context={[
              { label: "Workspace", value: me.workspace.name },
              { label: "List", value: suite.data.name },
              { label: "Tests", value: String(resolved?.members.length ?? 0) },
              { label: "Projects", value: String(resolved?.mapping.length ?? 0) },
              { label: "Excluded", value: String(resolved?.exclusions.length ?? 0) },
            ]}
            confirmLabel="Run list"
            onConfirm={run}
            onCancel={() => setConfirmRun(false)}
          />
          <ConfirmDialog
            open={confirmArchive}
            destructive
            title="Archive this list"
            description="Archived lists stay readable and keep their past batches, but cannot run or change."
            context={[
              { label: "Workspace", value: me.workspace.name },
              { label: "List", value: suite.data.name },
            ]}
            confirmLabel="Archive list"
            onConfirm={archive}
            onCancel={() => setConfirmArchive(false)}
          />
        </>
      ) : null}
    </StatusView>
  );
}

interface IncludedState {
  readonly [projectId: string]: string;
}

/** One project of the form: include it and pick its environment explicitly. */
function ProjectRow(props: {
  readonly project: ProjectSummary;
  readonly environmentId: string | undefined;
  readonly onChange: (environmentId: string | undefined) => void;
  readonly error: string | null;
}): ReactNode {
  const { project, environmentId, onChange } = props;
  const included = environmentId !== undefined;
  const environments = usePaged<EnvironmentSummary>(
    `/projects/${encodeURIComponent(project.id)}/environments`,
    {},
    100,
  );
  const usable = environments.items.filter((item) => !item.archivedAt);
  const checkboxId = `include-${project.id}`;
  const selectId = `environment-${project.id}`;
  return (
    <li className="project-row">
      <label htmlFor={checkboxId}>
        <input
          id={checkboxId}
          type="checkbox"
          checked={included}
          onChange={(event) => onChange(event.target.checked ? "" : undefined)}
        />{" "}
        <UntrustedText value={project.name} maxLength={80} />
      </label>
      {included ? (
        <FormField label="Environment" id={selectId} error={props.error} required>
          {(control) => (
            <select
              {...control}
              name={selectId}
              value={environmentId}
              onChange={(event) => onChange(event.target.value)}
            >
              <option value="">Choose an environment</option>
              {usable.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
      ) : null}
    </li>
  );
}

function ListCreatePage(): ReactNode {
  return <ListForm existing={null} etag={null} />;
}

function ListEditPage(): ReactNode {
  const { suiteId = "" } = useParams();
  const suite = useResource<SuiteView>(`/suites/${encodeURIComponent(suiteId)}`);
  if (suite.status === "not-found") return <NotFoundPage />;
  return (
    <StatusView status={suite.status} error={suite.error} onRetry={() => void suite.reload()}>
      {suite.data ? <ListForm existing={suite.data} etag={suite.etag} /> : null}
    </StatusView>
  );
}

function ListForm({
  existing,
  etag,
}: {
  readonly existing: SuiteView | null;
  readonly etag: string | null;
}): ReactNode {
  const editing = existing !== null;
  const navigate = useNavigate();
  const projects = usePaged<ProjectSummary>("/projects", {}, 100);
  const dynamic = existing?.selection.kind === "dynamic" ? existing.selection : null;
  const firstFilter = dynamic?.projects[0]?.filter;
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [tags, setTags] = useState(firstFilter?.tags?.join(", ") ?? "");
  const [nameContains, setNameContains] = useState(firstFilter?.nameContains ?? "");
  const [kind, setKind] = useState<"dynamic" | "fixed">(existing?.selection.kind ?? "dynamic");
  const [included, setIncluded] = useState<IncludedState>(
    Object.fromEntries(
      (dynamic?.projects ?? []).map((binding) => [binding.projectId, binding.environmentId]),
    ),
  );
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  usePageTitle(editing ? "Edit list" : "New list");
  const fixedEdit = existing?.selection.kind === "fixed";

  function dynamicSelection(): Selection {
    const tagList = tags
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const filter = {
      ...(tagList.length ? { tags: tagList } : {}),
      ...(nameContains.trim() ? { nameContains: nameContains.trim() } : {}),
    };
    return {
      kind: "dynamic",
      projects: Object.entries(included).map(([projectId, environmentId]) => ({
        projectId,
        environmentId,
        ...(Object.keys(filter).length ? { filter } : {}),
      })),
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting.current) return;
    const found: FieldIssue[] = [];
    if (name.trim() === "") found.push({ fieldId: "list-name", message: "Enter a name." });
    const chosen = Object.entries(included);
    if (!fixedEdit) {
      if (chosen.length === 0)
        found.push({
          fieldId: `include-${projects.items[0]?.id ?? "none"}`,
          message: "Include at least one project.",
        });
      for (const [projectId, environmentId] of chosen)
        if (environmentId === "")
          found.push({
            fieldId: `environment-${projectId}`,
            message: "Choose an environment for every included project.",
          });
    }
    setIssues(found);
    setFailure(null);
    setAttempt((count) => count + 1);
    if (found.length > 0) return;
    submitting.current = true;
    setPending(true);
    try {
      let selection: Selection | undefined = fixedEdit ? undefined : dynamicSelection();
      if (selection && kind === "fixed" && !editing) {
        const preview = await api<Expansion>("POST", "/suites/preview", {
          body: { name: name.trim(), selection },
        });
        selection = {
          kind: "fixed",
          members: preview.data.members.map((member) => ({
            testId: member.testId,
            revisionId: member.revisionId,
            environmentId: member.environmentId,
          })),
        };
      }
      const body = {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(selection ? { selection } : {}),
      };
      const saved = editing
        ? await api<SuiteView>("PATCH", `/suites/${encodeURIComponent(existing.id)}`, {
            body,
            ifMatch: etag,
          })
        : await api<SuiteView>("POST", "/suites", { body });
      navigate(`/lists/${encodeURIComponent(saved.data.id)}`);
    } catch (error) {
      setFailure(describeError(error));
      setAttempt((count) => count + 1);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <h1>{editing ? "Edit list" : "New list"}</h1>
      <ErrorSummary
        key={attempt}
        issues={failure ? [{ fieldId: "list-name", message: failure }] : issues}
      />
      <form onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          label="Name"
          name="list-name"
          value={name}
          onChange={setName}
          required
          error={issues.find((issue) => issue.fieldId === "list-name")?.message ?? null}
        />
        <TextField
          label="Description"
          name="list-description"
          value={description}
          onChange={setDescription}
        />
        {fixedEdit ? (
          <p className="banner tone-info" role="note">
            A fixed list is a snapshot of pinned revisions. Create a new list to change which tests
            it pins.
          </p>
        ) : (
          <>
            {editing ? null : (
              <fieldset>
                <legend>Kind</legend>
                <label>
                  <input
                    type="radio"
                    name="list-kind"
                    checked={kind === "dynamic"}
                    onChange={() => setKind("dynamic")}
                  />{" "}
                  Dynamic filter: re-resolved every time it runs
                </label>
                <label>
                  <input
                    type="radio"
                    name="list-kind"
                    checked={kind === "fixed"}
                    onChange={() => setKind("fixed")}
                  />{" "}
                  Fixed snapshot: pins today's approved revisions
                </label>
              </fieldset>
            )}
            <fieldset>
              <legend>Projects and environments</legend>
              <StatusView
                status={projects.status}
                error={projects.error}
                onRetry={() => void projects.reload()}
                empty={
                  <ViewState
                    kind="empty"
                    title="No projects"
                    message="Create a project before building a list."
                  />
                }
              >
                <ul className="plain">
                  {projects.items
                    .filter((project) => !project.archivedAt)
                    .map((project) => (
                      <ProjectRow
                        key={project.id}
                        project={project}
                        environmentId={included[project.id]}
                        error={
                          issues.find((issue) => issue.fieldId === `environment-${project.id}`)
                            ?.message ?? null
                        }
                        onChange={(environmentId) =>
                          setIncluded((current) => {
                            const next = { ...current };
                            if (environmentId === undefined) delete next[project.id];
                            else next[project.id] = environmentId;
                            return next;
                          })
                        }
                      />
                    ))}
                </ul>
              </StatusView>
            </fieldset>
            <TextField
              label="Only tests tagged"
              name="list-tags"
              value={tags}
              onChange={setTags}
              hint="Comma separated. Applies to every included project. Leave empty for all tests."
            />
            <TextField
              label="Only tests whose name contains"
              name="list-name-contains"
              value={nameContains}
              onChange={setNameContains}
            />
          </>
        )}
        <div className="actions">
          <button type="submit" className="button" aria-disabled={pending}>
            {pending ? "Saving…" : editing ? "Save list" : "Create list"}
          </button>
          <Link className="button secondary" to={existing ? `/lists/${existing.id}` : "/lists"}>
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/lists",
    title: "Lists",
    element: <ListsPage />,
    nav: { label: "Lists", section: "Automation" },
  },
  { path: "/lists/new", title: "New list", element: <ListCreatePage /> },
  { path: "/lists/:suiteId", title: "List", element: <ListDetailPage /> },
  { path: "/lists/:suiteId/edit", title: "Edit list", element: <ListEditPage /> },
];
