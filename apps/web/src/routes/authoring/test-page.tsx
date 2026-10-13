import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, api } from "../../api";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { type Column, DataTable } from "../../components/data-table";
import { DiffView } from "../../components/diff-view";
import { FormField } from "../../components/form";
import { useAnnounce } from "../../components/live-region";
import { useSelectContext } from "../../components/portal-context";
import { UntrustedText } from "../../components/untrusted-text";
import { StatusView } from "../../components/view-state";
import { usePageTitle } from "../../hooks/use-page-title";
import { usePaged, useResource } from "../../hooks/use-resource";
import type { ProjectSummary } from "../home";
import { NotFoundPage } from "../not-found";
import { HistoryPanel } from "./history-panel";
import {
  type DraftDoc,
  enc,
  type HistoryEntry,
  parsePlanText,
  prettyPlan,
  type RevisionDoc,
  type RevisionState,
  type RunDoc,
  type TestDoc,
  type Validation,
} from "./model";
import { ErrorNotice, Pill, useAction } from "./parts";
import { PlanEditor } from "./plan-editor";
import { RefinementChat } from "./refinement-chat";

interface EnvironmentRow {
  readonly id: string;
  readonly name: string;
  readonly archivedAt: string | null;
}

const stateLabels: Readonly<Record<RevisionState | "executed", string>> = {
  current: "Current",
  candidate: "Candidate",
  accepted: "Accepted",
  superseded: "Superseded",
  executed: "Executed",
};
const stateTone = {
  current: "success",
  candidate: "info",
  accepted: "neutral",
  superseded: "neutral",
  executed: "info",
} as const;
const stateShape = {
  current: "check",
  candidate: "clock",
  accepted: "check",
  superseded: "stop",
  executed: "info",
} as const;

function download(revision: RevisionDoc): void {
  const body = JSON.stringify(
    {
      revisionId: revision.id,
      ordinal: revision.ordinal,
      contentHash: revision.contentHash,
      plan: revision.plan,
    },
    null,
    2,
  );
  const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${revision.id}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

interface EditorProps {
  readonly test: TestDoc;
  readonly base: RevisionDoc;
  readonly draft: DraftDoc | null;
  readonly environments: readonly EnvironmentRow[];
  readonly defaultEnvironmentId: string | null;
  readonly onDraftChanged: () => Promise<void>;
  readonly onPublished: (revisionId: string) => Promise<void>;
  readonly onRan: (runId: string) => Promise<void>;
}

function DraftRecovery({
  conflict,
  mine,
  onUseStored,
  onKeepMine,
}: {
  conflict: { current: unknown; currentVersion: number };
  mine: string;
  onUseStored: () => void;
  onKeepMine: () => void;
}): ReactNode {
  return (
    <section
      className="banner tone-warning"
      role="alert"
      aria-label="Draft conflict"
      data-testid="draft-conflict"
    >
      <div>
        <p>
          <strong>This draft changed somewhere else.</strong> Another session of yours saved a newer
          draft. Nothing was overwritten.
        </p>
        <DiffView
          before={prettyPlan(conflict.current)}
          after={mine}
          caption="Saved draft against your edits"
        />
        <div className="authoring-actions">
          <button type="button" className="button secondary" onClick={onUseStored}>
            Use the saved draft
          </button>
          <button type="button" className="button" onClick={onKeepMine}>
            Keep my edits
          </button>
        </div>
      </div>
    </section>
  );
}

function Editor(props: EditorProps): ReactNode {
  const { test, base, draft } = props;
  const announce = useAnnounce();
  const baseText = useMemo(() => prettyPlan(base.plan), [base.plan]);
  const [text, setText] = useState(draft ? prettyPlan(draft.plan) : baseText);
  const [draftVersion, setDraftVersion] = useState<number | null>(draft?.version ?? null);
  const [restored, setRestored] = useState(draft !== null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [chosenEnvironment, setChosenEnvironment] = useState<string | null>(null);
  // The list may still be loading when the editor mounts, so the choice is derived, not copied.
  const environmentId =
    chosenEnvironment ?? props.defaultEnvironmentId ?? props.environments[0]?.id ?? "";
  const [reviewing, setReviewing] = useState(false);
  const [justification, setJustification] = useState("");
  const [draftConflict, setDraftConflict] = useState<{
    current: unknown;
    currentVersion: number;
  } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const saveAction = useAction();
  const runAction = useAction();

  useEffect(() => {
    // A fresh base revision or a different stored draft starts the editor over.
    setText(draft ? prettyPlan(draft.plan) : baseText);
    setDraftVersion(draft?.version ?? null);
    setRestored(draft !== null);
    setReviewing(false);
  }, [draft, baseText]);

  const dirty = text !== baseText;
  const parsed = parsePlanText(text);
  const invalid = parseError !== null || (validation !== null && !validation.valid);

  async function saveDraft(overrideVersion?: number): Promise<void> {
    if (parsed.error !== null) return;
    const version = overrideVersion ?? draftVersion;
    const saved = await saveAction.run(async () => {
      try {
        const result = await api<DraftDoc>("PUT", `/tests/${enc(test.id)}/draft`, {
          body: {
            baseRevisionId: base.id,
            plan: parsed.plan,
            ...(version === null ? {} : { expectedVersion: version }),
          },
        });
        return result.data;
      } catch (error) {
        if (error instanceof ApiError && error.code === "REVISION_CONFLICT") {
          const diff = error.details.diff as
            | { current: unknown; currentVersion: number }
            | undefined;
          if (diff)
            setDraftConflict({ current: diff.current, currentVersion: diff.currentVersion });
        }
        throw error;
      }
    });
    if (saved) {
      setDraftVersion(saved.version);
      setDraftConflict(null);
      setRestored(false);
      announce("Draft saved. The published revision is unchanged.");
      await props.onDraftChanged();
    }
  }

  async function discardDraft(): Promise<void> {
    const done = await saveAction.run(async () => {
      if (draftVersion !== null) await api("DELETE", `/tests/${enc(test.id)}/draft`);
      return true;
    });
    if (done) {
      setText(baseText);
      setDraftVersion(null);
      setRestored(false);
      setDraftConflict(null);
      announce("Draft discarded.");
      await props.onDraftChanged();
    }
  }

  async function publish(): Promise<void> {
    if (parsed.error !== null) throw new Error(parsed.error);
    try {
      const created = await api<RevisionDoc>("POST", `/tests/${enc(test.id)}/revisions`, {
        body: {
          origin: "manual",
          plan: parsed.plan,
          parentId: base.id,
          ...(justification.trim() ? { justification: justification.trim() } : {}),
        },
      });
      if (draftVersion !== null) await api("DELETE", `/tests/${enc(test.id)}/draft`);
      setReviewing(false);
      setPublishing(false);
      setJustification("");
      announce(`Revision ${created.data.ordinal} saved as a candidate.`);
      await props.onPublished(created.data.id);
    } catch (error) {
      throw new Error(
        error instanceof ApiError ? `${error.message} (${error.code})` : "Publishing failed.",
      );
    }
  }

  const runBlock = dirty
    ? "Save your edits as a revision before running; a run always uses a saved revision."
    : validation === null
      ? "Checking the plan…"
      : validation.runnable
        ? null
        : "The plan has problems that block running. They are listed above.";

  async function run(): Promise<void> {
    const receipt = await runAction.run(async () => {
      const result = await api<{ runId: string }>("POST", "/runs", {
        body: { testId: test.id, revisionId: base.id, environmentId },
      });
      return result.data;
    });
    if (receipt) {
      setLastRun(receipt.runId);
      announce("Run requested.");
      await props.onRan(receipt.runId);
    }
  }

  return (
    <section aria-labelledby="editor-heading" className="editor">
      <h2 id="editor-heading">
        Edit from revision {base.ordinal} <code>{base.id}</code>
      </h2>
      {restored ? (
        <p className="banner tone-info" role="status" data-testid="draft-restored">
          Restored your unsaved draft{draft ? ` (saved ${draft.updatedAt})` : ""}. The published
          revision has not changed.
          {draft?.baseSuperseded ? " The revision it was based on has since been superseded." : ""}
        </p>
      ) : null}
      <PlanEditor
        label="Plan"
        value={text}
        baseText={baseText}
        onChange={setText}
        projectId={test.projectId}
        environmentId={environmentId || null}
        testId={test.id}
        onValidation={(result, error) => {
          setValidation(result);
          setParseError(error);
        }}
      />
      {draftConflict ? (
        <DraftRecovery
          conflict={draftConflict}
          mine={text}
          onUseStored={() => {
            setText(prettyPlan(draftConflict.current));
            setDraftVersion(draftConflict.currentVersion);
            setDraftConflict(null);
            saveAction.clear();
          }}
          onKeepMine={() => void saveDraft(draftConflict.currentVersion)}
        />
      ) : (
        <ErrorNotice error={saveAction.error} />
      )}
      <div className="authoring-actions">
        <button
          type="button"
          className="button secondary"
          disabled={
            saveAction.pending || parsed.error !== null || (!dirty && draftVersion === null)
          }
          onClick={() => void saveDraft()}
        >
          Save draft
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={saveAction.pending || draftVersion === null}
          onClick={() => void discardDraft()}
        >
          Discard draft
        </button>
        <button
          type="button"
          className="button"
          disabled={!dirty || invalid}
          onClick={() => setReviewing(true)}
        >
          Review and publish
        </button>
      </div>
      {reviewing ? (
        <section aria-label="Review before publishing" data-testid="publish-review">
          <h3>Changes to publish</h3>
          <DiffView
            before={baseText}
            after={text}
            caption={`Revision ${base.ordinal} against your edits`}
          />
          <FormField label="Why are you changing this?" hint="Kept in the revision history.">
            {(control) => (
              <input
                {...control}
                value={justification}
                maxLength={500}
                onChange={(event) => setJustification(event.target.value)}
              />
            )}
          </FormField>
          <div className="authoring-actions">
            <button type="button" className="button" onClick={() => setPublishing(true)}>
              Publish as a new revision
            </button>
            <button type="button" className="button secondary" onClick={() => setReviewing(false)}>
              Keep editing
            </button>
          </div>
        </section>
      ) : null}
      <ConfirmDialog
        open={publishing}
        title="Publish a new revision?"
        description="A new immutable revision is created as a candidate. The current revision, and any Run that used it, are not changed."
        context={[
          { label: "Test", value: test.name },
          { label: "Based on", value: `revision ${base.ordinal}` },
        ]}
        confirmLabel="Publish"
        onCancel={() => setPublishing(false)}
        onConfirm={publish}
      />
      <h3>Run this revision</h3>
      <FormField label="Environment">
        {(control) => (
          <select
            {...control}
            value={environmentId}
            onChange={(event) => setChosenEnvironment(event.target.value)}
          >
            {props.environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {runBlock ? (
        <p role="status" data-testid="run-blocked">
          {runBlock}
        </p>
      ) : null}
      <div className="authoring-actions">
        <button
          type="button"
          className="button"
          disabled={runBlock !== null || runAction.pending || environmentId === ""}
          onClick={() => void run()}
        >
          Run revision {base.ordinal}
        </button>
      </div>
      <ErrorNotice error={runAction.error} />
      {lastRun ? (
        <p role="status" data-testid="run-requested">
          Run requested: <Link to={`/runs/${enc(lastRun)}`}>{lastRun}</Link>
        </p>
      ) : null}
    </section>
  );
}

function TestView({
  test,
  reloadTest,
}: {
  test: TestDoc;
  reloadTest: () => Promise<void>;
}): ReactNode {
  const announce = useAnnounce();
  const project = useResource<ProjectSummary>(`/projects/${enc(test.projectId)}`);
  useSelectContext(project.data ? { id: project.data.id, name: project.data.name } : null);
  const revisions = usePaged<RevisionDoc>(`/tests/${enc(test.id)}/revisions`, undefined, 100);
  const history = usePaged<HistoryEntry>(`/tests/${enc(test.id)}/history`, undefined, 100);
  const runs = usePaged<RunDoc>("/runs", { testId: test.id }, 100);
  const environments = usePaged<EnvironmentRow>(`/projects/${enc(test.projectId)}/environments`);
  const draft = useResource<DraftDoc>(`/tests/${enc(test.id)}/draft`);
  const [baseId, setBaseId] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<RevisionDoc | null>(null);

  const ordered = useMemo(
    () => [...revisions.items].sort((a, b) => b.ordinal - a.ordinal),
    [revisions.items],
  );
  const states = useMemo(
    () => new Map(history.items.map((entry) => [entry.id, entry.states])),
    [history.items],
  );
  const executed = useMemo(() => new Set(runs.items.map((run) => run.revisionId)), [runs.items]);
  const storedDraft = draft.status === "ready" ? draft.data : null;
  const base =
    ordered.find(
      (revision) =>
        revision.id === (baseId ?? storedDraft?.baseRevisionId ?? test.activeRevisionId),
    ) ??
    ordered[0] ??
    null;
  const activeEnvironments = environments.items.filter((environment) => !environment.archivedAt);

  const columns: Column<RevisionDoc>[] = [
    {
      key: "ordinal",
      header: "Revision",
      render: (revision) => (
        <>
          <strong>{revision.ordinal}</strong> <code>{revision.id}</code>
        </>
      ),
    },
    {
      key: "states",
      header: "State",
      render: (revision) => {
        const badges: (RevisionState | "executed")[] = [
          ...(states.get(revision.id) ??
            (revision.id === test.activeRevisionId ? ["current" as const] : [])),
          ...(executed.has(revision.id) ? ["executed" as const] : []),
        ];
        return (
          <ul className="kinds">
            {badges.map((state) => (
              <li key={state}>
                <Pill
                  label={stateLabels[state]}
                  tone={stateTone[state]}
                  shape={stateShape[state]}
                />
              </li>
            ))}
            {draft.status === "ready" && draft.data?.baseRevisionId === revision.id ? (
              <li>
                <Pill label="Your draft" tone="warning" shape="clock" />
              </li>
            ) : null}
          </ul>
        );
      },
    },
    {
      key: "origin",
      header: "Origin",
      render: (revision) => (
        <>
          {revision.origin} · <UntrustedText value={revision.author} maxLength={60} />
        </>
      ),
    },
    {
      key: "createdAt",
      header: "Created",
      render: (revision) => <time dateTime={revision.createdAt}>{revision.createdAt}</time>,
    },
    {
      key: "actions",
      header: "Actions",
      render: (revision) => (
        <div className="authoring-actions">
          <button type="button" className="button secondary" onClick={() => setBaseId(revision.id)}>
            Edit from revision {revision.ordinal}
          </button>
          <button type="button" className="button secondary" onClick={() => download(revision)}>
            Download revision {revision.ordinal}
          </button>
          {revision.id !== test.activeRevisionId && test.activeRevisionId ? (
            <button
              type="button"
              className="button secondary"
              onClick={() => setPromoting(revision)}
            >
              Make revision {revision.ordinal} current
            </button>
          ) : null}
        </div>
      ),
    },
  ];

  async function refresh(): Promise<void> {
    await Promise.all([revisions.reload(), history.reload(), draft.reload(), reloadTest()]);
  }

  return (
    <>
      <h1>
        <UntrustedText value={test.name} maxLength={160} />
      </h1>
      <dl className="context">
        <dt>Priority</dt>
        <dd>{test.priority}</dd>
        <dt>Current revision</dt>
        <dd>{test.activeRevisionId ? <code>{test.activeRevisionId}</code> : "None yet"}</dd>
        <dt>Project</dt>
        <dd className="link-row">
          <Link to={`/projects/${enc(test.projectId)}/tests`}>All tests</Link>
          <Link to={`/projects/${enc(test.projectId)}/proposals`}>Proposals</Link>
        </dd>
      </dl>
      <section aria-labelledby="revisions-heading">
        <h2 id="revisions-heading">Revisions</h2>
        <p className="hint">
          Revisions never change once saved. A Run keeps the revision it started with, even after a
          newer one is published.
        </p>
        <StatusView
          status={revisions.status}
          error={revisions.error}
          onRetry={() => void revisions.reload()}
        >
          <DataTable
            caption="Test revisions"
            columns={columns}
            rows={ordered}
            rowKey={(revision) => revision.id}
          />
        </StatusView>
      </section>
      {base ? (
        <Editor
          key={`${base.id}:${storedDraft?.id ?? "none"}:${storedDraft?.version ?? 0}`}
          test={test}
          base={base}
          draft={storedDraft && storedDraft.baseRevisionId === base.id ? storedDraft : null}
          environments={activeEnvironments}
          defaultEnvironmentId={project.data?.defaultEnvironmentId ?? null}
          onDraftChanged={() => draft.reload()}
          onPublished={async () => {
            setBaseId(null);
            await refresh();
          }}
          onRan={async () => {
            await runs.reload();
          }}
        />
      ) : null}
      <HistoryPanel history={history} />
      {base ? (
        <RefinementChat subject={{ kind: "test", id: test.id, baseRevisionId: base.id }} />
      ) : null}
      <ConfirmDialog
        open={promoting !== null}
        title="Make this revision current?"
        description="Future runs of this test use this revision. Earlier runs keep the revision they used."
        context={[
          { label: "Test", value: test.name },
          { label: "Revision", value: promoting ? `${promoting.ordinal} (${promoting.id})` : "" },
        ]}
        confirmLabel="Make current"
        onCancel={() => setPromoting(null)}
        onConfirm={async () => {
          if (!promoting || !test.activeRevisionId) return;
          try {
            await api("POST", `/tests/${enc(test.id)}/promote`, {
              body: { revisionId: promoting.id, expectedActiveRevisionId: test.activeRevisionId },
              ifMatch: test.version,
            });
          } catch (error) {
            throw new Error(
              error instanceof ApiError ? `${error.message} (${error.code})` : "Promotion failed.",
            );
          }
          announce(`Revision ${promoting.ordinal} is now current.`);
          setPromoting(null);
          await refresh();
        }}
      />
    </>
  );
}

export function TestPage(): ReactNode {
  const { testId = "" } = useParams();
  const test = useResource<TestDoc>(`/tests/${enc(testId)}`);
  usePageTitle(test.data?.name ?? "Test");
  if (test.status === "not-found" || test.status === "forbidden") return <NotFoundPage />;
  return (
    <StatusView status={test.status} error={test.error} onRetry={() => void test.reload()}>
      {test.data ? <TestView test={test.data} reloadTest={test.reload} /> : null}
    </StatusView>
  );
}
