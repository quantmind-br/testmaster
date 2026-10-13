import { type ReactNode, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../../api";
import { type Column, DataTable } from "../../components/data-table";
import { FormField } from "../../components/form";
import { useAnnounce } from "../../components/live-region";
import { useSelectContext } from "../../components/portal-context";
import { UntrustedText } from "../../components/untrusted-text";
import { StatusView, ViewState } from "../../components/view-state";
import { usePageTitle } from "../../hooks/use-page-title";
import { usePaged, useResource } from "../../hooks/use-resource";
import type { ProjectSummary } from "../home";
import { NotFoundPage } from "../not-found";
import { type BatchSummary, enc } from "./model";
import { ErrorNotice, Pill, useAction } from "./parts";

interface Usage {
  readonly calls: readonly unknown[];
  readonly unknownCostCalls: number;
  readonly lifetimeBudget: {
    readonly tokenBudget: {
      readonly limit: number | null;
      readonly used: number;
      readonly remaining: number | null;
    } | null;
  };
}

interface RequirementRow {
  readonly id: string;
  readonly approval: string | null;
}

const scopes = {
  backend: { label: "Backend (HTTP)", scope: ["backend"] },
  frontend: { label: "Frontend (browser)", scope: ["frontend"] },
  auto: {
    label: "Frontend and backend (the model chooses per requirement)",
    scope: ["frontend", "backend"],
  },
  integration: { label: "Integration only", scope: ["integration"] },
} as const;
type ScopeKey = keyof typeof scopes;

const stateTone = {
  proposed: "info",
  accepted: "success",
  rejected: "neutral",
  stale: "warning",
} as const;

const columns: Column<BatchSummary>[] = [
  {
    key: "id",
    header: "Batch",
    render: (batch) => <Link to={`/proposal-batches/${enc(batch.id)}`}>{batch.id}</Link>,
  },
  {
    key: "state",
    header: "State",
    render: (batch) =>
      batch.stale ? (
        <Pill label="Stale source" tone="warning" shape="warn" />
      ) : (
        <Pill
          label={batch.state[0]?.toUpperCase() + batch.state.slice(1)}
          tone={stateTone[batch.state]}
        />
      ),
  },
  {
    key: "counts",
    header: "Proposals",
    render: (batch) =>
      `${batch.counts.proposed} pending, ${batch.counts.accepted} accepted, ${batch.counts.rejected} rejected`,
  },
  {
    key: "origin",
    header: "Origin",
    render: (batch) =>
      batch.refinesTestId ? (
        <>
          Refinement of <Link to={`/tests/${enc(batch.refinesTestId)}`}>{batch.refinesTestId}</Link>
        </>
      ) : (
        <UntrustedText value={batch.origin} maxLength={60} />
      ),
  },
  {
    key: "createdAt",
    header: "Created",
    sortValue: (batch) => batch.createdAt,
    render: (batch) => <time dateTime={batch.createdAt}>{batch.createdAt}</time>,
  },
];

function GeneratePanel({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: () => void;
}): ReactNode {
  const navigate = useNavigate();
  const announce = useAnnounce();
  const [scope, setScope] = useState<ScopeKey>("backend");
  const [deadline, setDeadline] = useState("300");
  const action = useAction();
  const controller = useRef<AbortController | null>(null);
  // Kept across a cancel or failure: generating again with it resumes instead of duplicating.
  const key = useRef<string | null>(null);
  const usage = useResource<Usage>("/usage", { projectId });
  const sources = usePaged<{ id: string }>(`/projects/${enc(projectId)}/sources`);
  const requirements = useResource<{ requirements: readonly RequirementRow[] }>(
    `/projects/${enc(projectId)}/requirements`,
  );
  const requirementList = requirements.data?.requirements ?? [];
  const [phase, setPhase] = useState<"idle" | "running" | "cancelled" | "failed">("idle");
  const approved = requirementList.filter((item) => item.approval !== null).length;
  const seconds = Number(deadline);
  const deadlineError =
    Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600
      ? null
      : "Enter a whole number of seconds between 1 and 3600.";

  async function generate(): Promise<void> {
    if (deadlineError) return;
    key.current ??= crypto.randomUUID();
    controller.current = new AbortController();
    setPhase("running");
    const batch = await action.run(async () => {
      try {
        const result = await api<{ id: string }>(
          "POST",
          `/projects/${enc(projectId)}/proposal-batches`,
          {
            body: {
              inputRefs: [],
              scope: scopes[scope].scope,
              budget: { deadlineMs: seconds * 1000 },
            },
            idempotencyKey: key.current ?? crypto.randomUUID(),
            signal: (controller.current ?? new AbortController()).signal,
          },
        );
        return result.data;
      } catch (error) {
        if (controller.current?.signal.aborted) setPhase("cancelled");
        else setPhase("failed");
        throw error;
      }
    });
    controller.current = null;
    void usage.reload();
    if (batch) {
      key.current = null;
      setPhase("idle");
      announce("Proposals generated.");
      onDone();
      navigate(`/proposal-batches/${enc(batch.id)}`);
    }
  }

  const budget = usage.data?.lifetimeBudget.tokenBudget ?? null;
  const resumable = key.current !== null && phase !== "running";
  return (
    <section aria-labelledby="generate-heading">
      <h2 id="generate-heading">Generate proposals</h2>
      <p className="hint">
        Generation reads the approved requirements and asks the model for test proposals. Nothing
        becomes a test until a person reviews and accepts it.
      </p>
      <dl className="context" aria-label="Generation inputs and budget">
        <dt>Sources</dt>
        <dd data-testid="source-count">
          {sources.items.length}
          {sources.hasMore ? "+" : ""}
        </dd>
        <dt>Requirements approved</dt>
        <dd data-testid="requirement-count">
          {approved} of {requirementList.length}
        </dd>
        <dt>Model calls so far</dt>
        <dd data-testid="call-count">{usage.data ? usage.data.calls.length : "…"}</dd>
        <dt>Token budget</dt>
        <dd data-testid="token-budget">
          {budget && budget.limit !== null && budget.remaining !== null ? (
            <>
              {budget.used.toLocaleString("en-US")} used of {budget.limit.toLocaleString("en-US")},{" "}
              {budget.remaining.toLocaleString("en-US")} remaining
            </>
          ) : (
            `No limit set for this project${budget ? ` (${budget.used.toLocaleString("en-US")} used)` : ""}`
          )}
        </dd>
        <dt>Calls with unknown cost</dt>
        <dd>{usage.data?.unknownCostCalls ?? "…"}</dd>
      </dl>
      <FormField label="What to generate">
        {(control) => (
          <select
            {...control}
            value={scope}
            disabled={phase === "running"}
            onChange={(event) => setScope(event.target.value as ScopeKey)}
          >
            {(Object.keys(scopes) as ScopeKey[]).map((option) => (
              <option key={option} value={option}>
                {scopes[option].label}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField
        label="Time limit (seconds)"
        hint="Generation stops when it passes this limit."
        error={deadlineError}
      >
        {(control) => (
          <input
            {...control}
            inputMode="numeric"
            value={deadline}
            disabled={phase === "running"}
            onChange={(event) => setDeadline(event.target.value)}
          />
        )}
      </FormField>
      <div className="authoring-actions">
        <button
          type="button"
          className="button"
          disabled={phase === "running" || deadlineError !== null}
          onClick={() => void generate()}
        >
          {phase === "running"
            ? "Generating…"
            : resumable
              ? "Resume generation"
              : "Generate proposals"}
        </button>
        {phase === "running" ? (
          <button
            type="button"
            className="button secondary"
            onClick={() => controller.current?.abort()}
          >
            Cancel generation
          </button>
        ) : null}
      </div>
      <p role="status" data-testid="generation-phase">
        {phase === "running"
          ? "Generation is running. Cancelling keeps the sources and requirements already prepared."
          : null}
        {phase === "cancelled"
          ? "Generation was cancelled. Nothing was created; sources and requirements are unchanged. Resume to try again."
          : null}
        {phase === "failed"
          ? "Generation did not finish. Resume to try again; nothing was created."
          : null}
      </p>
      <ErrorNotice error={action.error} />
    </section>
  );
}

function ProposalsView({ projectId }: { projectId: string }): ReactNode {
  const batches = usePaged<BatchSummary>(`/projects/${enc(projectId)}/proposal-batches`);
  return (
    <>
      <GeneratePanel projectId={projectId} onDone={() => void batches.reload()} />
      <h2>Proposal batches</h2>
      <StatusView
        status={batches.status}
        error={batches.error}
        onRetry={() => void batches.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No proposals yet"
            message="Generate proposals from approved requirements to review them here."
          />
        }
      >
        <DataTable
          caption="Proposal batches"
          columns={columns}
          rows={batches.items}
          rowKey={(batch) => batch.id}
          pager={{
            hasMore: batches.hasMore,
            loading: false,
            onLoadMore: () => void batches.loadMore(),
          }}
        />
      </StatusView>
    </>
  );
}

export function ProposalsPage(): ReactNode {
  const { projectId = "" } = useParams();
  const project = useResource<ProjectSummary>(`/projects/${enc(projectId)}`);
  useSelectContext(project.data ? { id: project.data.id, name: project.data.name } : null);
  usePageTitle("Proposals");
  if (project.status === "not-found") return <NotFoundPage />;
  return (
    <StatusView status={project.status} error={project.error} onRetry={() => void project.reload()}>
      <h1>Proposals</h1>
      <div className="link-row">
        <Link to={`/projects/${enc(projectId)}/tests`}>Tests</Link>
        <Link to={`/projects/${enc(projectId)}`}>Project overview</Link>
      </div>
      <ProposalsView projectId={projectId} />
    </StatusView>
  );
}
