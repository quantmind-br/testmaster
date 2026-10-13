import type { ReactNode } from "react";
import { Link } from "react-router";
import { usePaged, useResource } from "../hooks/use-resource";
import {
  type AnalysisRecord,
  analysisCalibrated,
  describeAvailability,
  describeBaseline,
  describeConclusion,
  describeConfidence,
  describeHealingAdvice,
  describeHypothesis,
  describeSource,
  failureKindLabels,
  type HealingProposalRecord,
  recommendedActionLabels,
} from "../lib/healing-view";
import type { RunRecord } from "../lib/run-types";
import { type Column, DataTable } from "./data-table";
import { DescribedBadge, EvidenceList, HealingStatusBadge, RiskBadge } from "./healing-badges";
import { Icon } from "./status";
import { UntrustedText } from "./untrusted-text";
import { ViewState } from "./view-state";

interface UsageCall {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly purpose: string;
  readonly outcome: string;
  readonly cacheHit: boolean;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly reasoningTokens: number | null;
  };
}

interface UsageReport {
  readonly calls: readonly UsageCall[];
}

function tokens(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

const usageColumns: Column<UsageCall>[] = [
  { key: "purpose", header: "Purpose", render: (call) => <UntrustedText value={call.purpose} /> },
  {
    key: "model",
    header: "Provider and model",
    render: (call) => <UntrustedText value={`${call.provider} / ${call.model}`} maxLength={160} />,
  },
  { key: "input", header: "Input tokens", render: (call) => tokens(call.usage.inputTokens) },
  { key: "output", header: "Output tokens", render: (call) => tokens(call.usage.outputTokens) },
  {
    key: "reasoning",
    header: "Reasoning tokens",
    render: (call) => tokens(call.usage.reasoningTokens),
  },
  {
    key: "outcome",
    header: "Outcome",
    render: (call) => `${call.outcome}${call.cacheHit ? " (cache hit)" : ""}`,
  },
];

const proposalColumns: Column<HealingProposalRecord>[] = [
  {
    key: "id",
    header: "Proposal",
    render: (proposal) => (
      <Link to={`/healing-proposals/${encodeURIComponent(proposal.id)}`}>
        <code>{proposal.id}</code>
      </Link>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (proposal) => <HealingStatusBadge status={proposal.status} />,
  },
  { key: "risk", header: "Risk", render: (proposal) => <RiskBadge risk={proposal.risk} /> },
  {
    key: "revision",
    header: "Candidate revision",
    render: (proposal) => <code>{proposal.candidateRevisionId}</code>,
  },
];

function HealingProposals({ runId }: { runId: string }): ReactNode {
  const proposals = usePaged<HealingProposalRecord>(
    `/runs/${encodeURIComponent(runId)}/healing-proposals`,
  );
  // A caller who may read the Run but not healing simply has no proposals section.
  if (proposals.status === "forbidden" || proposals.status === "not-found") return null;
  return (
    <section aria-labelledby={`proposals-${runId}`}>
      <h3 id={`proposals-${runId}`}>Healing proposals for this Run</h3>
      {proposals.status === "loading" ? <ViewState kind="loading" /> : null}
      {proposals.status === "error" ? (
        <ViewState kind="error" error={proposals.error} onRetry={() => void proposals.reload()} />
      ) : null}
      {proposals.status === "empty" ? (
        <p>
          No healing proposal exists for this Run. The failed Run stays as it is whether or not one
          is ever proposed.
        </p>
      ) : null}
      {proposals.status === "ready" ? (
        <DataTable
          caption="Healing proposals for this Run"
          columns={proposalColumns}
          rows={proposals.items}
          rowKey={(proposal) => proposal.id}
        />
      ) : null}
    </section>
  );
}

function ModelUsage({
  runId,
  analysis,
}: {
  runId: string;
  analysis: AnalysisRecord | null;
}): ReactNode {
  const usage = useResource<UsageReport>("/usage", { runId });
  // Usage is hidden quietly for a caller without the usage permission.
  if (usage.status === "forbidden" || usage.status === "not-found" || usage.status === "loading")
    return null;
  if (usage.status === "error")
    return <ViewState kind="error" title="Model usage unavailable" error={usage.error} />;
  const calls = usage.data?.calls ?? [];
  if (calls.length === 0 && analysis?.source !== "model") return null;
  return (
    <section aria-labelledby={`usage-${runId}`}>
      <h3 id={`usage-${runId}`}>Model usage</h3>
      {calls.length === 0 ? (
        <p>No model call is recorded for this Run.</p>
      ) : (
        <DataTable
          caption="Model calls recorded for this Run"
          columns={usageColumns}
          rows={calls}
          rowKey={(call) => call.id}
        />
      )}
    </section>
  );
}

function Confidence({
  value,
  calibrated,
}: {
  value: number | null;
  calibrated: boolean | null;
}): ReactNode {
  const confidence = describeConfidence(value, calibrated);
  return (
    <>
      <strong>{confidence.label}</strong> <span className="hint">{confidence.caveat}</span>
    </>
  );
}

function AnalysisBody({ analysis }: { analysis: AnalysisRecord }): ReactNode {
  const source = describeSource(analysis.source);
  const conclusion = describeConclusion(analysis);
  const diagnosis = analysis.diagnosis;
  return (
    <>
      <dl className="context">
        <dt>Source</dt>
        <dd>
          <DescribedBadge described={source} /> {source.text}
          {analysis.modelCallId ? (
            <>
              {" "}
              Model call <code>{analysis.modelCallId}</code>.
            </>
          ) : null}
        </dd>
        <dt>Failure kind</dt>
        <dd>{failureKindLabels[analysis.failureKind]}</dd>
        <dt>Confidence</dt>
        <dd>
          <Confidence value={analysis.confidence} calibrated={analysisCalibrated(analysis)} />
        </dd>
        <dt>Recommended action</dt>
        <dd>{recommendedActionLabels[analysis.recommendedAction]}</dd>
      </dl>

      <div
        className={`banner tone-${conclusion.tone}`}
        data-conclusion={diagnosis?.conclusion.status}
      >
        <Icon shape={conclusion.shape} />
        <div>
          <p className="state-title">{conclusion.label}</p>
          <p>
            <UntrustedText value={conclusion.text} maxLength={1_000} />
          </p>
        </div>
      </div>

      {diagnosis?.observation ? (
        <section>
          <h3>Observation</h3>
          <p>
            <UntrustedText value={diagnosis.observation.summary} maxLength={1_000} />
          </p>
          <dl className="context">
            {diagnosis.observation.expected !== null ? (
              <>
                <dt>Expected</dt>
                <dd>
                  <UntrustedText value={diagnosis.observation.expected} maxLength={500} />
                </dd>
              </>
            ) : null}
            {diagnosis.observation.observed !== null ? (
              <>
                <dt>Observed</dt>
                <dd>
                  <UntrustedText value={diagnosis.observation.observed} maxLength={500} />
                </dd>
              </>
            ) : null}
            {diagnosis.observation.absence !== null ? (
              <>
                <dt>Absence</dt>
                <dd>{diagnosis.observation.absence.replace(/_/g, " ")}</dd>
              </>
            ) : null}
          </dl>
          <EvidenceList refs={diagnosis.observation.evidenceRefs} runId={analysis.runId} />
        </section>
      ) : null}

      {diagnosis && diagnosis.chain.length > 0 ? (
        <section>
          <h3>Evidence chain</h3>
          <ol>
            {diagnosis.chain.map((link) => (
              <li key={`${link.stepId}-${link.operation}`}>
                <strong>
                  <UntrustedText value={link.stepId} maxLength={80} />
                </strong>{" "}
                (<UntrustedText value={link.operation} maxLength={60} />, {link.status}):{" "}
                <UntrustedText value={link.summary} maxLength={500} />
                {link.verifies ? (
                  <>
                    {" "}
                    Verifies <UntrustedText value={link.verifies} maxLength={120} />.
                  </>
                ) : null}{" "}
                <span className="hint">Baseline: {describeBaseline(link.baseline)}.</span>
                <EvidenceList refs={link.evidenceRefs} runId={analysis.runId} />
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section>
        <h3>Hypotheses</h3>
        {analysis.hypotheses.length === 0 ? (
          <p>No hypothesis was proposed. No cause is asserted.</p>
        ) : (
          <ul>
            {analysis.hypotheses.map((hypothesis) => {
              const trust = describeHypothesis(hypothesis);
              return (
                <li key={hypothesis.text}>
                  <p>
                    <DescribedBadge described={trust} />{" "}
                    <UntrustedText value={hypothesis.text} maxLength={800} />
                  </p>
                  <p className="hint">{trust.text}</p>
                  <p>
                    Confidence:{" "}
                    <Confidence value={hypothesis.confidence} calibrated={hypothesis.calibrated} />
                  </p>
                  <p>Supported by</p>
                  <EvidenceList
                    refs={hypothesis.supports}
                    runId={analysis.runId}
                    empty="No supporting evidence cited."
                  />
                  <p>Contradicted by</p>
                  <EvidenceList
                    refs={hypothesis.contradicts}
                    runId={analysis.runId}
                    empty="No contradicting evidence cited."
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {diagnosis && diagnosis.alternatives.length > 0 ? (
        <section>
          <h3>Alternatives considered</h3>
          <ul>
            {diagnosis.alternatives.map((alternative) => (
              <li key={alternative.text}>
                {failureKindLabels[alternative.failureKind]}:{" "}
                <UntrustedText value={alternative.text} maxLength={600} />
                <EvidenceList refs={alternative.evidenceRefs} runId={analysis.runId} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {diagnosis && diagnosis.nextSteps.length > 0 ? (
        <section>
          <h3>Next steps</h3>
          <ul>
            {diagnosis.nextSteps.map((step) => (
              <li key={step.text}>
                <UntrustedText value={step.text} maxLength={500} />{" "}
                <span className="hint">
                  ({step.source === "model" ? "model suggestion" : "rules"})
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {diagnosis && diagnosis.evidenceGaps.length > 0 ? (
        <section>
          <h3>Evidence gaps</h3>
          <ul>
            {diagnosis.evidenceGaps.map((gap) => (
              <li key={gap}>
                <UntrustedText value={gap} maxLength={500} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3>Limitations</h3>
        {analysis.limitations.length === 0 ? (
          <p>No limitation was recorded. That is not a guarantee that the analysis is complete.</p>
        ) : (
          <ul>
            {analysis.limitations.map((limitation) => (
              <li key={limitation}>
                <UntrustedText value={limitation} maxLength={500} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {diagnosis ? (
        <section>
          <h3>Healing advice</h3>
          <p>
            {describeHealingAdvice(diagnosis.healing.advice)}{" "}
            <UntrustedText value={diagnosis.healing.reason} maxLength={500} />
          </p>
        </section>
      ) : null}
    </>
  );
}

/**
 * What the Run's analysis says, and how far to trust it. A missing, pending, partial or
 * unavailable analysis is its own state; none of them reads as "no problem found".
 */
export function AnalysisPanel({ runId, run }: { runId: string; run: RunRecord }): ReactNode {
  const analysis = useResource<AnalysisRecord>(`/runs/${encodeURIComponent(runId)}/analysis`);
  const found = analysis.status === "ready" && analysis.data !== null;
  const availability = describeAvailability(run.analysisStatus, found);
  let body: ReactNode;
  if (analysis.status === "loading") body = <ViewState kind="loading" />;
  else if (analysis.status === "error")
    body = <ViewState kind="error" error={analysis.error} onRetry={() => void analysis.reload()} />;
  else if (!found || availability.kind === "unavailable")
    body = (
      <ViewState
        kind={availability.kind === "pending" ? "loading" : "empty"}
        title={availability.title}
        message={availability.message}
      />
    );
  else if (availability.kind === "partial" || availability.kind === "pending")
    body = (
      <ViewState kind="partial" message={`${availability.title}. ${availability.message}`}>
        {analysis.data ? <AnalysisBody analysis={analysis.data} /> : null}
      </ViewState>
    );
  else body = analysis.data ? <AnalysisBody analysis={analysis.data} /> : null;
  return (
    <section
      aria-labelledby={`analysis-${runId}`}
      data-analysis-state={analysis.status === "loading" ? "loading" : availability.kind}
    >
      <h2 id={`analysis-${runId}`}>Analysis</h2>
      {body}
      <HealingProposals runId={runId} />
      <ModelUsage runId={runId} analysis={analysis.data} />
    </section>
  );
}
