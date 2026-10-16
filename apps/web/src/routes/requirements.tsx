import { type ReactNode, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { ConfirmDialog } from "../components/confirm-dialog";
import { DiffView } from "../components/diff-view";
import { ErrorSummary, type FieldIssue, FormField } from "../components/form";
import { useSelectContext } from "../components/portal-context";
import { StatusBadge } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged, useResource } from "../hooks/use-resource";
import { type Failure, toFailure } from "../lib/api-error";
import type {
  Origin,
  ProjectRef,
  RequirementChange,
  RequirementReview,
  SourceListItem,
} from "../lib/m4-types";
import { shortHash } from "../lib/onboarding";
import { NotFoundPage } from "./not-found";
import type { PortalRoute } from "./types";

const changeLabels: Record<string, string> = {
  requirement_added: "Requirement added",
  requirement_removed: "Requirement removed",
  interpretation_changed: "Interpretation changed",
  edited: "Edited",
  approved: "Approved",
  rejected: "Rejected",
  approval_reset: "Approval reset",
  conflict_decided: "Conflict decided",
  normalized: "Normalized",
};

const originLabels: Record<string, string> = {
  explicit: "Stated explicitly",
  user_spec: "From the user's specification",
  inferred: "Inferred — needs review",
  observed: "Observed in the application",
};

function location(origin: Origin): string {
  const { ref } = origin;
  if (ref.jsonPointer) return ref.jsonPointer;
  const parts: string[] = [];
  if (ref.relativePath) parts.push(ref.relativePath);
  if (ref.page !== undefined) parts.push(`page ${ref.page}`);
  if (ref.offset !== undefined) parts.push(`bytes ${ref.offset}–${ref.offset + (ref.length ?? 0)}`);
  return parts.join(", ") || "whole source";
}

function OriginView({ origin }: { origin: Origin }): ReactNode {
  return (
    <li className="origin" data-current={origin.current} data-testid="origin">
      <p>
        <strong>
          <UntrustedText value={origin.sourceName ?? "Removed source"} maxLength={120} />
        </strong>
        {origin.revisionOrdinal !== null ? `, revision ${origin.revisionOrdinal}` : ""} ·{" "}
        {origin.current ? (
          "current revision"
        ) : (
          <span className="badge tone-warning">Superseded revision</span>
        )}
      </p>
      <p>
        Span <code>{location(origin)}</code>
        {origin.spanHash ? (
          <>
            {" "}
            · hash <code>{shortHash(origin.spanHash)}</code>
          </>
        ) : null}
      </p>
      {origin.excerpt ? (
        <blockquote>
          <UntrustedText value={origin.excerpt} maxLength={600} block />
        </blockquote>
      ) : (
        <p>The cited span is no longer stored for this revision.</p>
      )}
      {origin.sourceId ? (
        <p>
          <Link to={`../sources/${encodeURIComponent(origin.sourceId)}`} relative="path">
            Open the source
          </Link>
        </p>
      ) : null}
    </li>
  );
}

function ChangeEntry({ change }: { change: RequirementChange }): ReactNode {
  return (
    <li data-change-kind={change.kind}>
      <p>
        <strong>{changeLabels[change.kind] ?? change.kind}</strong>
        {change.requirementKey ? (
          <>
            {" "}
            · <code>{change.requirementKey}</code>
          </>
        ) : null}{" "}
        · <time dateTime={change.at}>{change.at}</time> · <code>{change.actorId}</code>
      </p>
      {change.note ? (
        <p>
          <UntrustedText value={change.note} maxLength={500} />
        </p>
      ) : null}
      {change.before !== null && change.after !== null ? (
        <DiffView
          before={change.before}
          after={change.after}
          caption={`Interpretation change ${change.requirementKey ?? change.requirementId ?? ""}`}
        />
      ) : null}
    </li>
  );
}

function NormalizeForm({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: () => Promise<void>;
}): ReactNode {
  const sources = usePaged<SourceListItem>(`/projects/${encodeURIComponent(projectId)}/sources`);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const usable = sources.items.filter((item) => item.activeRevisionId !== null);
  async function run(): Promise<void> {
    if (busy || chosen.size === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      await api("POST", `/projects/${encodeURIComponent(projectId)}/requirements/normalizations`, {
        body: { sourceRevisionIds: [...chosen] },
      });
      await onDone();
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Normalize requirements">
      <h2>Normalize requirements</h2>
      <p className="hint">
        The selected sources are sent to the configured model provider when it is allowed by the
        server's policy. The model never approves anything.
      </p>
      <StatusView
        status={sources.status}
        error={sources.error}
        onRetry={() => void sources.reload()}
        empty={<p>Add a source first.</p>}
      >
        <fieldset>
          <legend>Sources to normalize</legend>
          {usable.map((source) => (
            <label key={source.id} className="choice">
              <input
                type="checkbox"
                checked={chosen.has(source.activeRevisionId ?? "")}
                onChange={(event) => {
                  const next = new Set(chosen);
                  const revision = source.activeRevisionId ?? "";
                  if (event.target.checked) next.add(revision);
                  else next.delete(revision);
                  setChosen(next);
                }}
              />{" "}
              <UntrustedText value={source.displayName} maxLength={120} /> (revision{" "}
              {source.overview.active.ordinal})
            </label>
          ))}
        </fieldset>
      </StatusView>
      {failure ? (
        <div className="banner tone-danger" role="alert" data-testid="normalize-failure">
          <p>
            {failure.code}: {failure.message}
          </p>
        </div>
      ) : null}
      <button
        type="button"
        className="button"
        aria-disabled={busy || chosen.size === 0}
        onClick={() => void run()}
      >
        {busy ? "Normalizing…" : "Normalize"}
      </button>
    </section>
  );
}

function ConflictCard({
  review,
  conflict,
  projectId,
  onDone,
}: {
  review: RequirementReview;
  conflict: RequirementReview["conflicts"][number];
  projectId: string;
  onDone: () => Promise<void>;
}): ReactNode {
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const idFor = (name: string) => `${conflict.id}-${name}`;
  async function decide(): Promise<void> {
    if (busy) return;
    const found: FieldIssue[] = [];
    if (!selected)
      found.push({ fieldId: idFor("choice"), message: "Choose the statement to keep" });
    if (!reason.trim()) found.push({ fieldId: idFor("reason"), message: "Explain the decision" });
    setAttempt((value) => value + 1);
    setIssues(found);
    if (found.length > 0) return;
    setBusy(true);
    setFailure(null);
    try {
      await api("POST", `/projects/${encodeURIComponent(projectId)}/requirements/decisions`, {
        body: {
          conflictId: conflict.id,
          selectedRequirementId: selected,
          reason: reason.trim(),
          expectedVersion: review.version,
        },
      });
      await onDone();
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setBusy(false);
    }
  }
  const resolution = conflict.resolution;
  return (
    <li className="conflict" data-conflict={conflict.id} data-resolved={resolution !== null}>
      <h3>
        <UntrustedText value={conflict.reason} maxLength={300} />
      </h3>
      <p>
        {resolution ? (
          <StatusBadge status="verified" label="Decision recorded" />
        ) : (
          <StatusBadge status="blocked" label="Needs a decision" />
        )}
      </p>
      <h4>Where it comes from</h4>
      <ul>
        {conflict.origins.map((origin) => (
          <OriginView key={`${origin.sourceRevisionId}-${origin.spanHash}`} origin={origin} />
        ))}
      </ul>
      {resolution ? (
        <p data-testid="decision">
          Kept <code>{resolution.selectedRequirementId}</code> because{" "}
          <UntrustedText value={resolution.reason} maxLength={500} /> (by{" "}
          <code>{resolution.actorId}</code>).
        </p>
      ) : (
        <>
          <ErrorSummary key={attempt} issues={issues} />
          <fieldset id={idFor("choice")}>
            <legend>Statement to keep</legend>
            {conflict.requirementIds.map((id) => {
              const requirement = review.requirements.find((item) => item.id === id);
              return (
                <label key={id} className="choice">
                  <input
                    type="radio"
                    name={idFor("choice")}
                    checked={selected === id}
                    onChange={() => setSelected(id)}
                  />{" "}
                  <UntrustedText value={requirement?.text ?? id} maxLength={300} />
                </label>
              );
            })}
          </fieldset>
          <FormField
            label="Why"
            required
            id={idFor("reason")}
            error={issues.find((item) => item.fieldId === idFor("reason"))?.message ?? null}
          >
            {(props) => (
              <textarea
                {...props}
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </FormField>
          {failure ? (
            <p className="error" role="alert">
              {failure.code}: {failure.message}
            </p>
          ) : null}
          <button
            type="button"
            className="button"
            aria-disabled={busy}
            onClick={() => void decide()}
          >
            Record decision
          </button>
        </>
      )}
    </li>
  );
}

function RequirementCard({
  requirement,
  review,
  onDone,
}: {
  requirement: RequirementReview["requirements"][number];
  review: RequirementReview;
  onDone: () => Promise<void>;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const unresolved = review.conflicts.some(
    (conflict) => conflict.requirementIds.includes(requirement.id) && conflict.resolution === null,
  );
  return (
    <li className="requirement" data-requirement={requirement.key ?? requirement.id}>
      <h3>
        {requirement.key ? <code>{requirement.key}</code> : null}{" "}
        <UntrustedText value={requirement.text} maxLength={400} />
      </h3>
      <p>
        <span className="badge">
          {originLabels[requirement.originKind] ?? requirement.originKind}
        </span>{" "}
        {requirement.rejection ? (
          <span className="badge tone-warning">Rejected</span>
        ) : requirement.approval ? (
          <StatusBadge status="verified" label="Approved" />
        ) : (
          <StatusBadge status="pending" label="Not approved" />
        )}{" "}
        {requirement.supersededOrigin ? (
          <span className="badge tone-warning">Rests on a superseded source revision</span>
        ) : null}
      </p>
      {requirement.acceptanceCriteria.length > 0 ? (
        <>
          <h4>Acceptance criteria</h4>
          <ul>
            {requirement.acceptanceCriteria.map((item) => (
              <li key={item}>
                <UntrustedText value={item} maxLength={400} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {requirement.rejection ? (
        <p>
          Why it was rejected:{" "}
          <UntrustedText value={requirement.rejection.reason} maxLength={400} />
        </p>
      ) : null}
      {requirement.reason ? (
        <p>
          Why it was derived: <UntrustedText value={requirement.reason} maxLength={400} />
        </p>
      ) : null}
      <h4>Source spans</h4>
      {requirement.origins.length === 0 ? (
        <p data-testid="no-origin">No source span supports this requirement.</p>
      ) : (
        <ul>
          {requirement.origins.map((origin) => (
            <OriginView
              key={`${origin.sourceRevisionId}-${origin.spanHash}-${location(origin)}`}
              origin={origin}
            />
          ))}
        </ul>
      )}
      {requirement.approval || requirement.rejection ? null : (
        <>
          <button
            type="button"
            className="button secondary"
            aria-disabled={unresolved}
            onClick={() => {
              if (!unresolved) setConfirming(true);
            }}
          >
            Approve
          </button>
          {unresolved ? (
            <p className="hint">
              Decide the conflict this requirement is part of before approving it.
            </p>
          ) : null}
          <ConfirmDialog
            open={confirming}
            title="Approve requirement"
            description="An approved requirement can be used as the oracle for generated tests. Approving is a human decision and is recorded."
            context={[
              { label: "Requirement", value: requirement.key ?? requirement.id },
              { label: "Revision", value: String(requirement.version) },
            ]}
            confirmLabel="Approve"
            onCancel={() => setConfirming(false)}
            onConfirm={async () => {
              await api("POST", `/requirements/${encodeURIComponent(requirement.id)}/approve`, {
                ifMatch: requirement.version,
              });
              setConfirming(false);
              await onDone();
            }}
          />
        </>
      )}
    </li>
  );
}

function RequirementsPage(): ReactNode {
  const { projectId = "" } = useParams();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const project = useResource<ProjectRef>(base);
  const review = useResource<RequirementReview>(`${base}/requirements/review`);
  useSelectContext(project.data ? { id: project.data.id, name: project.data.name } : null);
  usePageTitle("Requirements");
  if (project.status === "not-found") return <NotFoundPage />;
  const data = review.data;
  const changes = (data?.changes ?? []).slice(0, 50);
  return (
    <>
      <h1>Requirements</h1>
      <StatusView
        status={review.status}
        error={review.error}
        onRetry={() => void review.reload()}
        empty={<ViewState kind="empty" title="No requirements yet" />}
      >
        {data ? (
          <>
            <p>
              Every statement below links to the exact source span it came from. Nothing is approved
              until a person approves it.
            </p>
            <section aria-label="Conflicts" data-testid="conflicts">
              <h2>Conflicts ({data.conflicts.length})</h2>
              {data.conflicts.length === 0 ? (
                <p>No conflict was found between the statements.</p>
              ) : (
                <ul className="plain">
                  {data.conflicts.map((conflict) => (
                    <ConflictCard
                      key={conflict.id}
                      review={data}
                      conflict={conflict}
                      projectId={projectId}
                      onDone={() => review.reload()}
                    />
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="Requirements list">
              <h2>Requirements ({data.requirements.length})</h2>
              {data.requirements.length === 0 ? (
                <ViewState
                  kind="empty"
                  title="No requirements yet"
                  message="Normalize your sources below to extract requirements."
                />
              ) : (
                <ul className="plain">
                  {data.requirements.map((requirement) => (
                    <RequirementCard
                      key={requirement.id}
                      requirement={requirement}
                      review={data}
                      onDone={() => review.reload()}
                    />
                  ))}
                </ul>
              )}
            </section>
            {data.openQuestions.length > 0 ? (
              <section aria-label="Open questions">
                <h2>Open questions</h2>
                <ul>
                  {data.openQuestions.map((question) => (
                    <li key={question}>
                      <UntrustedText value={question} maxLength={400} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <section aria-label="Interpretation history" data-testid="history">
              <h2>How the interpretation changed</h2>
              {changes.length === 0 ? (
                <p>No change has been recorded yet.</p>
              ) : (
                <ol className="plain">
                  {changes.map((change) => (
                    <ChangeEntry
                      key={`${change.at}-${change.kind}-${change.requirementKey}-${change.note}`}
                      change={change}
                    />
                  ))}
                </ol>
              )}
            </section>
          </>
        ) : null}
      </StatusView>
      <NormalizeForm projectId={projectId} onDone={() => review.reload()} />
    </>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/projects/:projectId/requirements",
    title: "Requirements",
    element: <RequirementsPage />,
    projectNav: { label: "Requirements", order: 40 },
  },
];
