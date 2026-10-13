import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, api } from "../../api";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { FormField } from "../../components/form";
import { useAnnounce } from "../../components/live-region";
import { useSelectContext } from "../../components/portal-context";
import { Icon } from "../../components/status";
import { StatusView } from "../../components/view-state";
import { usePageTitle } from "../../hooks/use-page-title";
import { useResource } from "../../hooks/use-resource";
import type { ProjectSummary } from "../home";
import { NotFoundPage } from "../not-found";
import { type BatchDetail, enc, type Preview, type Receipt } from "./model";
import { Pill } from "./parts";
import { ProposalCard } from "./proposal-card";

type Decision = "accept" | "reject";

function BatchView({
  detail,
  reload,
}: {
  detail: BatchDetail;
  reload: () => Promise<void>;
}): ReactNode {
  const { batch, proposals } = detail;
  const project = useResource<ProjectSummary>(`/projects/${enc(batch.projectId)}`);
  useSelectContext(project.data ? { id: project.data.id, name: project.data.name } : null);
  const announce = useAnnounce();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState<Decision | null>(null);
  const [receipt, setReceipt] = useState<{ decision: Decision; value: Receipt } | null>(null);
  const keys = useRef(new Map<string, string>());
  const ids = proposals.map((proposal) => proposal.id).join(",");
  const reloadAll = useCallback(async () => {
    await reload();
  }, [reload]);
  const loadLatest = useCallback(async (): Promise<BatchDetail | null> => {
    try {
      return (await api<BatchDetail>("GET", `/proposal-batches/${enc(batch.id)}`)).data;
    } catch {
      return null;
    }
  }, [batch.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the preview is a function of these
  useEffect(() => {
    const controller = new AbortController();
    const proposalIds = ids.split(",").filter(Boolean);
    if (proposalIds.length === 0) return;
    api<Preview>("POST", `/proposal-batches/${enc(batch.id)}/preview`, {
      body: { proposalIds },
      signal: controller.signal,
    })
      .then((result) => {
        setPreview(result.data);
        setPreviewError(null);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && error instanceof ApiError) setPreviewError(error);
      });
    return () => controller.abort();
  }, [batch.id, batch.version, ids, proposals]);

  const items = new Map(preview?.items.map((item) => [item.proposalId, item]));
  const chosen = proposals.filter((proposal) => selected.has(proposal.id));
  const chosenItems = chosen.map((proposal) => items.get(proposal.id));
  const unresolvedDuplicates = chosen.filter((proposal) => {
    const item = items.get(proposal.id);
    return item?.needsDecision && !acknowledged.has(proposal.id);
  });
  const policy = preview?.policy ?? null;
  const blockedReason =
    chosen.length === 0
      ? "Select at least one proposal."
      : chosenItems.some((item) => !item?.selectable)
        ? "A selected proposal is invalid or no longer pending."
        : unresolvedDuplicates.length > 0
          ? "Decide on the duplicate proposals you selected."
          : null;
  const policyText =
    policy?.reason === "write_permission_required"
      ? "Your role can read this batch but not accept it. Ask a maintainer or an administrator to review it."
      : (policy?.text ?? "");
  const acceptBlocked = blockedReason ?? (policy && !policy.canAccept ? policyText : null);

  function toggle(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  }

  async function decide(decision: Decision): Promise<void> {
    const proposalIds = chosen.map((proposal) => proposal.id).sort();
    const dups = proposalIds.filter((id) => acknowledged.has(id));
    const signature = JSON.stringify([decision, proposalIds, dups, batch.version, reason]);
    const key = keys.current.get(signature) ?? crypto.randomUUID();
    keys.current.set(signature, key);
    try {
      const result = await api<Receipt>("POST", `/proposal-batches/${enc(batch.id)}/${decision}`, {
        body: {
          proposalIds,
          expectedVersion: batch.version,
          ...(decision === "accept" && reason.trim() ? { reason: reason.trim() } : {}),
          ...(decision === "accept" && dups.length > 0 ? { acknowledgedDuplicates: dups } : {}),
        },
        ifMatch: batch.version,
        idempotencyKey: key,
      });
      setReceipt({ decision, value: result.data });
      setSelected(new Set());
      setAcknowledged(new Set());
      announce(
        decision === "accept" ? "Selected proposals accepted." : "Selected proposals rejected.",
      );
    } catch (error) {
      throw new Error(
        error instanceof ApiError ? `${error.message} (${error.code})` : "The request failed.",
      );
    }
    await reloadAll();
  }

  const open = proposals.filter((proposal) => proposal.state === "proposed");
  const stale = batch.state === "stale" || preview?.stale === true;
  return (
    <>
      <h1>Proposal batch</h1>
      <div className="link-row">
        <code>{batch.id}</code>
        {stale ? (
          <Pill label="Stale source" tone="warning" shape="warn" />
        ) : (
          <Pill
            label={batch.state[0]?.toUpperCase() + batch.state.slice(1)}
            tone={
              batch.state === "accepted"
                ? "success"
                : batch.state === "rejected"
                  ? "neutral"
                  : "info"
            }
          />
        )}
        <Link to={`/projects/${enc(batch.projectId)}/proposals`}>All batches</Link>
        <Link to={`/projects/${enc(batch.projectId)}/tests`}>Tests</Link>
      </div>
      {stale ? (
        <div className="banner tone-warning" role="status" data-testid="stale-banner">
          <Icon shape="warn" />
          <div>
            <p>
              <strong>The source changed after these proposals were generated.</strong> Review each
              one against the new source before accepting, or{" "}
              <Link to={`/projects/${enc(batch.projectId)}/proposals`}>generate again</Link>.
            </p>
            {preview?.staleReason ? <p className="mono">{preview.staleReason}</p> : null}
          </div>
        </div>
      ) : null}
      {policy ? (
        <p
          className={`banner tone-${policy.canAccept ? "info" : "warning"}`}
          role="status"
          data-testid="policy"
        >
          <Icon shape={policy.canAccept ? "info" : "lock"} />
          <span>{policyText}</span>
        </p>
      ) : null}
      {previewError ? (
        <p role="alert">
          The preview could not be loaded: {previewError.message} ({previewError.code}).
        </p>
      ) : null}
      <section aria-labelledby="proposal-list">
        <h2 id="proposal-list">Proposals ({open.length} pending)</h2>
        {proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            item={items.get(proposal.id)}
            projectId={batch.projectId}
            batchVersion={batch.version}
            selected={selected.has(proposal.id)}
            acknowledged={acknowledged.has(proposal.id)}
            onSelect={(on) => setSelected((current) => toggle(current, proposal.id, on))}
            onAcknowledge={(on) => setAcknowledged((current) => toggle(current, proposal.id, on))}
            onChanged={reloadAll}
            onLoadLatest={loadLatest}
            readOnlyReason={null}
          />
        ))}
      </section>
      <section aria-labelledby="decision-heading" className="decision">
        <h2 id="decision-heading">Decision</h2>
        <p data-testid="selection-summary">
          {chosen.length} of {open.length} pending proposals selected. Unselected proposals stay
          pending.
        </p>
        <FormField label="Reason (optional)" hint="Recorded with the decision.">
          {(control) => (
            <input
              {...control}
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </FormField>
        {acceptBlocked ? (
          <p role="status" data-testid="accept-blocked">
            {acceptBlocked}
          </p>
        ) : null}
        <div className="authoring-actions">
          <button
            type="button"
            className="button"
            disabled={acceptBlocked !== null}
            onClick={() => setConfirming("accept")}
          >
            Accept {chosen.length} selected
          </button>
          <button
            type="button"
            className="button danger"
            disabled={chosen.length === 0}
            onClick={() => setConfirming("reject")}
          >
            Reject {chosen.length} selected
          </button>
        </div>
      </section>
      {receipt ? (
        <section
          aria-label="Decision receipt"
          className="banner tone-success"
          role="status"
          data-testid="receipt"
        >
          <Icon shape="check" />
          <div>
            <p>
              <strong>{receipt.decision === "accept" ? "Accepted" : "Rejected"}.</strong>{" "}
              {receipt.value.accepted.length} test{receipt.value.accepted.length === 1 ? "" : "s"}{" "}
              created, {receipt.value.rejected.length} rejected, {receipt.value.retained.length}{" "}
              left pending.
            </p>
            {receipt.value.accepted.length > 0 ? (
              <ul>
                {receipt.value.accepted.map((testId) => (
                  <li key={testId}>
                    <Link to={`/tests/${enc(testId)}`}>{testId}</Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      ) : null}
      <ConfirmDialog
        open={confirming !== null}
        title={
          confirming === "reject" ? "Reject selected proposals?" : "Accept selected proposals?"
        }
        description={
          confirming === "reject"
            ? "The selected proposals are rejected. The others stay pending."
            : "Each selected proposal becomes a test revision. The others stay pending. Nothing runs automatically."
        }
        context={[
          { label: "Batch", value: batch.id },
          { label: "Selected", value: String(chosen.length) },
          { label: "Staying pending", value: String(open.length - chosen.length) },
        ]}
        confirmLabel={confirming === "reject" ? "Reject" : "Accept"}
        destructive={confirming === "reject"}
        onCancel={() => setConfirming(null)}
        onConfirm={async () => {
          if (confirming === null) return;
          await decide(confirming);
          setConfirming(null);
        }}
      />
    </>
  );
}

export function BatchPage(): ReactNode {
  const { batchId = "" } = useParams();
  const batch = useResource<BatchDetail>(`/proposal-batches/${enc(batchId)}`);
  usePageTitle("Proposal batch");
  if (batch.status === "not-found" || batch.status === "forbidden") return <NotFoundPage />;
  return (
    <StatusView status={batch.status} error={batch.error} onRetry={() => void batch.reload()}>
      {batch.data ? <BatchView detail={batch.data} reload={batch.reload} /> : null}
    </StatusView>
  );
}
