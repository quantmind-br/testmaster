import { type FormEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, api } from "../api";
import { useMe } from "../components/app-shell";
import { ConfirmDialog } from "../components/confirm-dialog";
import { type Column, DataTable } from "../components/data-table";
import { DiffView } from "../components/diff-view";
import { ErrorSummary, FormField } from "../components/form";
import {
  DescribedBadge,
  EvidenceList,
  HealingStatusBadge,
  RiskBadge,
} from "../components/healing-badges";
import { useAnnounce } from "../components/live-region";
import { Icon } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { useResource } from "../hooks/use-resource";
import {
  decideAcceptance,
  describeDecision,
  describeLifecycle,
  describeMutationFailure,
  describeRisk,
  formatChangeValue,
  type HealingProposalRecord,
  type HealingReviewRecord,
  type Lifecycle,
  type MutationFailure,
  maxRejectionReason,
  validateRejectionReason,
} from "../lib/healing-view";
import type { RunRecord } from "../lib/run-types";
import { NotFoundPage } from "./not-found";
import type { PortalRoute } from "./types";

type Candidate = HealingReviewRecord["identity"][number]["candidates"][number];

const candidateColumns: Column<Candidate>[] = [
  {
    key: "role",
    header: "Role",
    render: (item) => <UntrustedText value={item.role} maxLength={80} />,
  },
  {
    key: "name",
    header: "Name",
    render: (item) => <UntrustedText value={item.name} maxLength={160} />,
  },
  {
    key: "tag",
    header: "Tag",
    render: (item) => <UntrustedText value={item.tag} maxLength={40} />,
  },
  {
    key: "type",
    header: "Type",
    render: (item) => <UntrustedText value={item.type} maxLength={40} />,
  },
  {
    key: "label",
    header: "Label",
    render: (item) => <UntrustedText value={item.label} maxLength={160} />,
  },
  {
    key: "form",
    header: "Form",
    render: (item) => <UntrustedText value={item.form} maxLength={160} />,
  },
  {
    key: "matched",
    header: "Matches the new locator",
    render: (item) => (item.matched ? "Yes" : "No"),
  },
  { key: "visible", header: "Visible", render: (item) => (item.visible ? "Yes" : "No") },
];

function LifecycleView({ lifecycle }: { lifecycle: Lifecycle }): ReactNode {
  return (
    <>
      <p data-lifecycle-headline data-healed={lifecycle.healed ? "yes" : "no"}>
        <strong>{lifecycle.headline}</strong>
      </p>
      <ol>
        {lifecycle.steps.map((step) => (
          <li key={step.key} data-state={step.state}>
            <strong>{step.label}</strong> ({step.state.replace("-", " ")}): {step.detail}
          </li>
        ))}
      </ol>
    </>
  );
}

function VerificationLifecycle({
  proposal,
  onRefresh,
}: {
  proposal: HealingProposalRecord;
  onRefresh: () => Promise<void>;
}): ReactNode {
  const runId = proposal.verificationRunId ?? "";
  const run = useResource<RunRecord>(`/runs/${encodeURIComponent(runId)}`);
  if (run.status === "loading") return <ViewState kind="loading" />;
  const verification = run.data
    ? { runId, outcome: run.data.outcome, phase: run.data.phase }
    : { runId, outcome: null };
  return (
    <>
      <LifecycleView lifecycle={describeLifecycle(proposal, verification)} />
      {run.status !== "ready" ? (
        <p role="status">The verification Run could not be read, so its result is not known.</p>
      ) : null}
      <p>
        <Link to={`/runs/${encodeURIComponent(runId)}`}>Open verification Run {runId}</Link>
        {run.data && run.data.outcome === null ? (
          <>
            {" "}
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                void run.reload();
                void onRefresh();
              }}
            >
              Refresh status
            </button>
          </>
        ) : null}
      </p>
    </>
  );
}

function ChangeList({ review }: { review: HealingReviewRecord }): ReactNode {
  if (review.changes.length === 0) return <p>This proposal contains no changes.</p>;
  return (
    <ol>
      {review.changes.map((change) => (
        <li key={`${change.stepId}${change.path}`}>
          <p>
            Step <code>{change.stepId}</code>, field <code>{change.path}</code>
          </p>
          <DiffView
            caption={`Before and after for step ${change.stepId}, field ${change.path}`}
            before={formatChangeValue(change.before)}
            after={formatChangeValue(change.after)}
          />
        </li>
      ))}
    </ol>
  );
}

function IdentitySection({ review }: { review: HealingReviewRecord }): ReactNode {
  if (review.identity.length === 0) return null;
  return (
    <section aria-labelledby="healing-identity">
      <h2 id="healing-identity">Element identity</h2>
      {review.identity.map((entry) => (
        <div key={entry.stepId}>
          <h3>
            Step <code>{entry.stepId}</code>
          </h3>
          <p>
            {entry.equivalence === null
              ? "Equivalence could not be established from the recorded evidence. A human must judge it."
              : entry.equivalence.equivalent
                ? "The recorded candidates show the new locator matches the same element."
                : "The recorded candidates do not establish that the new locator matches the same element."}
          </p>
          {entry.equivalence && entry.equivalence.reasons.length > 0 ? (
            <ul>
              {entry.equivalence.reasons.map((reason) => (
                <li key={reason}>
                  <UntrustedText value={reason} maxLength={500} />
                </li>
              ))}
            </ul>
          ) : null}
          {entry.candidates.length === 0 ? (
            <p>No candidate elements were recorded for this step.</p>
          ) : (
            <DataTable
              caption={`Candidate elements recorded for step ${entry.stepId}`}
              columns={candidateColumns}
              rows={entry.candidates}
              rowKey={(item) => JSON.stringify(item)}
            />
          )}
        </div>
      ))}
    </section>
  );
}

function FailureBanner({
  failure,
  onReload,
  bannerRef,
}: {
  failure: MutationFailure;
  onReload: () => void;
  bannerRef: RefObject<HTMLDivElement | null>;
}): ReactNode {
  return (
    <div
      className="banner tone-danger"
      role="alert"
      tabIndex={-1}
      ref={bannerRef}
      data-failure={failure.kind}
    >
      <Icon shape={failure.kind === "forbidden" ? "lock" : "warn"} />
      <div>
        <p className="state-title">{failure.title}</p>
        <p>{failure.message}</p>
        {failure.kind === "forbidden" ? null : (
          <button type="button" className="button secondary" onClick={onReload}>
            Reload review
          </button>
        )}
      </div>
    </div>
  );
}

interface BodyProps {
  readonly proposal: HealingProposalRecord;
  readonly review: HealingReviewRecord | null;
  readonly reload: () => Promise<void>;
}

function ReviewBody({ proposal, review, reload }: BodyProps): ReactNode {
  const me = useMe();
  const announce = useAnnounce();
  const test = useResource<{ activeRevisionId?: string | null }>(
    `/tests/${encodeURIComponent(proposal.testId)}`,
  );
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<MutationFailure | null>(null);
  const [failureSeq, setFailureSeq] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [submits, setSubmits] = useState(0);
  const [rejecting, setRejecting] = useState(false);
  const bannerRef = useRef<HTMLDivElement>(null);
  // The alert takes focus once the confirm dialog has closed; closing it first would hand focus
  // back to the button that opened it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new failure (failureSeq) refocuses
  useEffect(() => {
    if (failure && !confirming) bannerRef.current?.focus();
  }, [failureSeq, confirming]);

  const canApprove = me.principal.kind === "human" && me.permissions.write;
  const acceptance = decideAcceptance({
    status: proposal.status,
    assertionsIntact: review ? review.preservedAssertions.intact : null,
    changeCount: proposal.changes.length,
    verificationRunId: proposal.verificationRunId,
    activeRevisionId: test.status === "ready" ? (test.data?.activeRevisionId ?? null) : null,
    baseRevisionId: proposal.baseRevisionId,
    canApprove,
  });
  // Rejecting never needs intact assertions; it only needs a reviewable proposal and the role.
  const rejectable = proposal.status === "proposed" && canApprove;
  const expectedVersion = review?.approval.expectedVersion ?? proposal.version ?? 1;

  async function decide(action: "accept" | "reject", body: unknown): Promise<boolean> {
    setFailure(null);
    setNotice(null);
    try {
      const result = await api<HealingProposalRecord>(
        "POST",
        `/healing-proposals/${encodeURIComponent(proposal.id)}/${action === "accept" ? "approve" : "reject"}`,
        { body },
      );
      const next = result.data;
      const message =
        action === "accept"
          ? `Proposal approved. Candidate revision ${next.candidateRevisionId} is not active until verification Run ${next.verificationRunId ?? "(being admitted)"} passes.`
          : "Proposal rejected. The test keeps its current revision.";
      setNotice(message);
      announce(message);
      await reload();
      return true;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const described = describeMutationFailure(error.code, action, error.message);
      setFailure(described);
      setFailureSeq((value) => value + 1);
      announce(described.title);
      return false;
    }
  }

  async function submitRejection(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSubmits((count) => count + 1);
    const problem = validateRejectionReason(reason);
    setReasonError(problem);
    if (problem !== null) return;
    setRejecting(true);
    try {
      if (await decide("reject", { reason: reason.trim() })) setReason("");
    } finally {
      setRejecting(false);
    }
  }

  const verification = review?.verification ?? null;
  const risk = describeRisk(review?.risk ?? proposal.risk);
  const decision = review ? describeDecision(review.automation.decision) : null;
  const refresh = async () => {
    await reload();
  };
  const limitations = [...new Set([...(review?.limitations ?? []), ...proposal.limitations])];
  return (
    <>
      <h1>Healing proposal</h1>
      <p>
        <HealingStatusBadge status={proposal.status} /> <RiskBadge risk={proposal.risk} />
      </p>
      {notice ? (
        <p className="banner tone-success" role="status" data-notice>
          <Icon shape="check" />
          <span>{notice}</span>
        </p>
      ) : null}
      {failure ? (
        <FailureBanner
          key={failureSeq}
          bannerRef={bannerRef}
          failure={failure}
          onReload={() => {
            setFailure(null);
            void reload();
          }}
        />
      ) : null}

      {review ? (
        <div
          className={`banner ${review.preservedAssertions.intact ? "tone-success" : "tone-danger"}`}
          data-assertions-intact={review.preservedAssertions.intact ? "yes" : "no"}
        >
          <Icon shape={review.preservedAssertions.intact ? "check" : "cross"} />
          <div>
            <p className="state-title">
              {review.preservedAssertions.intact
                ? "Assertions intact: healing does not change what the test checks"
                : "Assertions NOT intact: this candidate changes what the test checks"}
            </p>
            <p>
              Preserved assertions hash <code>{review.preservedAssertions.hash}</code> covers{" "}
              {review.preservedAssertions.stepIds.length} step
              {review.preservedAssertions.stepIds.length === 1 ? "" : "s"}
              {review.preservedAssertions.stepIds.length > 0
                ? `: ${review.preservedAssertions.stepIds.join(", ")}`
                : ""}
              .{" "}
              {review.preservedAssertions.intact
                ? "The candidate has exactly the same assertions as the base revision."
                : "Accepting is disabled. A change of assertions needs a normal edit and approval, never healing."}
            </p>
          </div>
        </div>
      ) : null}

      <section aria-labelledby="healing-lifecycle">
        <h2 id="healing-lifecycle">From failed Run to verified revision</h2>
        {proposal.verificationRunId ? (
          <VerificationLifecycle proposal={proposal} onRefresh={refresh} />
        ) : (
          <LifecycleView lifecycle={describeLifecycle(proposal, null)} />
        )}
      </section>

      <section aria-labelledby="healing-identity-table">
        <h2 id="healing-identity-table">Proposal</h2>
        <dl className="context">
          <dt>Proposal</dt>
          <dd>
            <code>{proposal.id}</code>
          </dd>
          <dt>Test</dt>
          <dd>
            <code>{proposal.testId}</code>
          </dd>
          <dt>Failed Run</dt>
          <dd>
            <Link to={`/runs/${encodeURIComponent(proposal.failedRunId)}`}>
              <code>{proposal.failedRunId}</code>
            </Link>
          </dd>
          <dt>Analysis</dt>
          <dd>{proposal.analysisId ? <code>{proposal.analysisId}</code> : "None recorded"}</dd>
          <dt>Base revision</dt>
          <dd>
            <code>{proposal.baseRevisionId}</code>
          </dd>
          <dt>Candidate revision</dt>
          <dd>
            <code>{proposal.candidateRevisionId}</code>
          </dd>
          <dt>Origin</dt>
          <dd>{proposal.modelCallId ? "Model-proposed" : "Not model-proposed"}</dd>
          <dt>Decided by</dt>
          <dd>
            {proposal.approvalMode === "manual"
              ? "A human reviewer"
              : proposal.approvalMode === "policy"
                ? "Project policy"
                : "Nobody yet"}
          </dd>
          <dt>Version</dt>
          <dd>{expectedVersion}</dd>
        </dl>
      </section>

      <section aria-labelledby="healing-reason">
        <h2 id="healing-reason">Why this change</h2>
        <UntrustedText value={proposal.diff} block maxLength={4_000} />
      </section>

      <section aria-labelledby="healing-changes">
        <h2 id="healing-changes">Changes, before and after</h2>
        {review ? <ChangeList review={review} /> : <ViewState kind="loading" />}
      </section>

      {review ? <IdentitySection review={review} /> : null}

      <section aria-labelledby="healing-policy">
        <h2 id="healing-policy">Risk and policy</h2>
        <dl className="context">
          <dt>Risk</dt>
          <dd>
            <DescribedBadge described={risk} /> {risk.text}
          </dd>
          {decision ? (
            <>
              <dt>Automation decision</dt>
              <dd>
                <DescribedBadge described={decision} /> {decision.text}
              </dd>
            </>
          ) : null}
        </dl>
        {review && review.automation.reasons.length > 0 ? (
          <>
            <h3>Reasons</h3>
            <ul>
              {review.automation.reasons.map((item) => (
                <li key={item}>
                  <UntrustedText value={item} maxLength={500} />
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {verification ? (
          <p>
            Verification Run:{" "}
            <Link to={`/runs/${encodeURIComponent(verification.runId)}`}>
              <code>{verification.runId}</code>
            </Link>{" "}
            ({verification.outcome ?? "not finished"}, gate {verification.gate})
          </p>
        ) : null}
      </section>

      <section aria-labelledby="healing-evidence">
        <h2 id="healing-evidence">Evidence</h2>
        <EvidenceList
          refs={review?.evidenceRefs ?? proposal.evidenceRefs}
          runId={proposal.failedRunId}
          empty="This proposal cites no evidence."
        />
      </section>

      <section aria-labelledby="healing-limitations">
        <h2 id="healing-limitations">Limitations</h2>
        {limitations.length === 0 ? (
          <p>No limitation was recorded.</p>
        ) : (
          <ul>
            {limitations.map((item) => (
              <li key={item}>
                <UntrustedText value={item} maxLength={500} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="healing-decision">
        <h2 id="healing-decision">Decision</h2>
        {proposal.status === "proposed" ? null : (
          <p>This proposal is {proposal.status}; no further decision is needed or possible here.</p>
        )}
        <div className="actions">
          <button
            type="button"
            className="button"
            aria-disabled={!acceptance.allowed}
            aria-describedby={acceptance.allowed ? undefined : "accept-unavailable"}
            onClick={() => {
              if (acceptance.allowed) setConfirming(true);
            }}
          >
            Accept proposal…
          </button>
        </div>
        {acceptance.allowed ? null : (
          <div id="accept-unavailable" data-testid="accept-unavailable">
            <p className="state-title">
              <Icon shape="lock" /> <span>Accept is unavailable</span>
            </p>
            <ul>
              {acceptance.reasons.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        <h3>Reject with a reason</h3>
        <form onSubmit={(event) => void submitRejection(event)} noValidate>
          <ErrorSummary
            key={submits}
            issues={reasonError ? [{ fieldId: "reject-reason", message: reasonError }] : []}
          />
          <FormField
            id="reject-reason"
            label="Reason"
            required
            hint="Recorded with the proposal. Say what is wrong with the change."
            error={reasonError}
          >
            {(control) => (
              <textarea
                {...control}
                rows={4}
                maxLength={maxRejectionReason}
                value={reason}
                disabled={!rejectable}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </FormField>
          <button
            type="submit"
            className="button secondary"
            aria-disabled={!rejectable || rejecting}
            onClick={(event) => {
              if (!rejectable || rejecting) event.preventDefault();
            }}
          >
            {rejecting ? "Rejecting…" : "Reject proposal"}
          </button>
          {rejectable ? null : (
            <p data-testid="reject-unavailable">
              {proposal.status === "proposed"
                ? "Your role cannot reject healing proposals. Approval needs a human member with write permission."
                : `This proposal is already ${proposal.status}.`}
            </p>
          )}
        </form>
      </section>

      <ConfirmDialog
        open={confirming}
        title="Accept this healing proposal?"
        description="Accepting creates a new verification Run on the candidate revision. The candidate becomes the active revision only if that new Run passes; the original failed Run stays failed."
        context={[
          { label: "Proposal", value: proposal.id },
          { label: "Candidate revision to create", value: proposal.candidateRevisionId },
          { label: "Current base revision", value: proposal.baseRevisionId },
          { label: "Expected proposal version", value: String(expectedVersion) },
          { label: "Changes", value: String(proposal.changes.length) },
          { label: "Assertions", value: "Unchanged (preserved hash verified)" },
        ]}
        confirmLabel="Accept and verify"
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          await decide("accept", { expectedVersion });
          setConfirming(false);
        }}
      />
    </>
  );
}

function HealingReviewPage(): ReactNode {
  const { proposalId = "" } = useParams();
  const id = encodeURIComponent(proposalId);
  const proposal = useResource<HealingProposalRecord>(`/healing-proposals/${id}`);
  const review = useResource<HealingReviewRecord>(`/healing-proposals/${id}/review`);
  usePageTitle(proposal.status === "not-found" ? "Not found" : "Healing proposal");
  // A missing proposal and one the caller may not see are the same page.
  if (proposal.status === "not-found") return <NotFoundPage />;
  return (
    <StatusView
      status={proposal.status}
      error={proposal.error}
      onRetry={() => void proposal.reload()}
    >
      {proposal.data ? (
        <>
          {review.status !== "ready" && review.status !== "loading" ? (
            <ViewState
              kind="partial"
              title="Review unavailable"
              message="Review unavailable. The change review could not be loaded, so before and after values and the assertion check are not shown. Accepting stays disabled."
            />
          ) : null}
          <ReviewBody
            proposal={proposal.data}
            review={review.status === "ready" ? review.data : null}
            reload={async () => {
              await Promise.all([proposal.reload(), review.reload()]);
            }}
          />
        </>
      ) : null}
    </StatusView>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/healing-proposals/:proposalId",
    title: "Healing proposal",
    element: <HealingReviewPage />,
  },
];
