import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { type UsePaged, usePaged } from "../hooks/use-resource";
import {
  buildDataFlow,
  describeFlowTable,
  describeStepTable,
  type FlowResource,
  type FlowTableRow,
  maskedValue,
  orphanedResources,
  type PlanLike,
  type StepTableRow,
} from "../lib/data-flow";
import type { AttemptRecord, StepRecord } from "../lib/run-types";
import { DataFlowGraphView, describeResourceState } from "./data-flow-graph";
import { type Column, DataTable } from "./data-table";
import { Icon, StatusBadge } from "./status";
import { UntrustedText } from "./untrusted-text";
import { ViewState } from "./view-state";

interface RevisionRecord {
  readonly id: string;
  readonly ordinal: number;
  readonly plan: PlanLike & { readonly name: string };
}
interface ResourceRow {
  readonly id: string;
  readonly resourceType: string;
  readonly state: string;
  readonly creatorAttemptId: string;
  readonly cleanupPlan: unknown;
}

export interface DataFlowPanelProps {
  readonly runId: string;
  readonly testId: string;
  readonly revisionId: string;
}

/** Keeps requesting pages until the caller has what it needs or the list ends. */
function useExhaust<T extends { id: string }>(paged: UsePaged<T>, done: boolean): void {
  const { status, hasMore, loadingMore, loadMore } = paged;
  useEffect(() => {
    if (status === "ready" && hasMore && !loadingMore && !done) void loadMore();
  }, [status, hasMore, loadingMore, loadMore, done]);
}

function stepIdOf(resource: ResourceRow): string | null {
  const plan = resource.cleanupPlan;
  if (plan === null || typeof plan !== "object" || !("stepId" in plan)) return null;
  return typeof plan.stepId === "string" ? plan.stepId : null;
}
function ResourceBadge({ state }: { state: string }): ReactNode {
  const descriptor = describeResourceState(state);
  return (
    <span className={`badge tone-${descriptor.tone}`} data-resource-state={state}>
      <Icon shape={descriptor.shape} />
      <span>{descriptor.label}</span>
    </span>
  );
}

function ProducerStatus({ status }: { status: FlowTableRow["producerStatus"] }): ReactNode {
  if (!status) return <span>No result</span>;
  return status.kind === "resource" ? (
    <ResourceBadge state={status.status} />
  ) : (
    <StatusBadge status={status.status} />
  );
}

const flowColumns: Column<FlowTableRow>[] = [
  {
    key: "name",
    header: "Variable / resource",
    render: (row) => (
      <code>
        <UntrustedText value={row.name} maxLength={80} />
      </code>
    ),
  },
  {
    key: "producedBy",
    header: "Produced by",
    render: (row) => <UntrustedText value={row.producedBy} maxLength={120} />,
  },
  {
    key: "consumedBy",
    header: "Consumed by",
    render: (row) => <UntrustedText value={row.consumedBy} maxLength={120} />,
  },
  {
    key: "sensitive",
    header: "Sensitive",
    render: (row) =>
      row.sensitive ? (
        <span>
          Yes · <span data-masked="">{maskedValue}</span>
        </span>
      ) : (
        "No"
      ),
  },
  {
    key: "status",
    header: "Runtime status of producer",
    render: (row) => <ProducerStatus status={row.producerStatus} />,
  },
  {
    key: "latency",
    header: "Latency",
    render: (row) => (row.latencyMs === null ? "—" : `${row.latencyMs} ms`),
  },
  {
    key: "notes",
    header: "Notes",
    render: (row) =>
      row.notes.length === 0 ? (
        "—"
      ) : (
        <ul className="plain-list">
          {row.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ),
  },
];

const stepColumns: Column<StepTableRow>[] = [
  {
    key: "step",
    header: "Step",
    render: (row) => (
      <>
        <UntrustedText value={row.label} maxLength={120} /> (<code>{row.operation}</code>)
      </>
    ),
  },
  {
    key: "request",
    header: "Request",
    render: (row) =>
      row.request ? (
        <code>
          <UntrustedText value={row.request} maxLength={160} />
        </code>
      ) : (
        "—"
      ),
  },
  {
    key: "result",
    header: "Result",
    render: (row) =>
      row.result ? <StatusBadge status={row.result.status} /> : <span>No result</span>,
  },
  {
    key: "latency",
    header: "Latency",
    render: (row) => (row.result ? `${row.result.durationMs} ms` : "—"),
  },
  {
    key: "observed",
    header: "Observed data",
    render: (row) =>
      row.observedWithheld ? (
        <span>
          Withheld: this step captures a sensitive value (<span data-masked="">{maskedValue}</span>)
        </span>
      ) : (
        "Open the evidence bundle"
      ),
  },
];

const resourceColumns: Column<ResourceRow>[] = [
  { key: "id", header: "Resource", render: (row) => <code>{row.id}</code> },
  {
    key: "type",
    header: "Type",
    render: (row) => <UntrustedText value={row.resourceType} maxLength={80} />,
  },
  { key: "state", header: "State", render: (row) => <ResourceBadge state={row.state} /> },
  {
    key: "step",
    header: "Created by step",
    render: (row) => <UntrustedText value={stepIdOf(row)} maxLength={80} />,
  },
  {
    key: "notes",
    header: "Notes",
    render: (row) =>
      ["cleaned"].includes(row.state)
        ? "Cleanup confirmed."
        : `Not confirmed cleaned up (${describeResourceState(row.state).label.toLowerCase()}). Review it before the next Run.`,
  },
];

function describeGraph(rows: readonly FlowTableRow[], nodes: number, edges: number): string {
  const unresolved = rows.filter((row) => row.notes.some((note) => note.startsWith("Unresolved")));
  const sensitive = rows.filter((row) => row.sensitive);
  return `${nodes} nodes and ${edges} edges. ${unresolved.length} unresolved reference(s), ${sensitive.length} sensitive value(s) hidden. The table below the graph lists the same information.`;
}

/**
 * Data flow of one Run (REQ-053): which step produces each variable, which steps consume it, what
 * each step returned and how long it took, and which resources were left behind. The plan comes
 * from the Run's own revision; results come from the chosen Attempt. Sensitive values are not
 * loaded, and the steps that capture them are marked as withholding observed data. The host page
 * owns the section heading.
 */
export function DataFlowPanel({ runId, testId, revisionId }: DataFlowPanelProps): ReactNode {
  const selectId = useId();
  const revisions = usePaged<RevisionRecord>(
    `/tests/${encodeURIComponent(testId)}/revisions`,
    {},
    100,
  );
  const attempts = usePaged<AttemptRecord>(`/runs/${encodeURIComponent(runId)}/attempts`, {}, 100);
  const steps = usePaged<StepRecord>(`/runs/${encodeURIComponent(runId)}/steps`, {}, 100);
  const resources = usePaged<ResourceRow>("/resources", { runId }, 100);
  const [chosen, setChosen] = useState<string | null>(null);

  const revision = revisions.items.find((item) => item.id === revisionId) ?? null;
  useExhaust(revisions, revision !== null);
  useExhaust(attempts, false);
  useExhaust(steps, false);
  useExhaust(resources, false);

  const ordered = useMemo(
    () => [...attempts.items].sort((a, b) => a.number - b.number),
    [attempts.items],
  );
  const attempt = ordered.find((item) => item.id === chosen) ?? ordered.at(-1) ?? null;
  const attemptSteps = useMemo(
    () => steps.items.filter((step) => (attempt ? step.attemptId === attempt.id : true)),
    [steps.items, attempt],
  );
  const flowResources = useMemo<FlowResource[]>(
    () =>
      resources.items
        .filter((item) => (attempt ? item.creatorAttemptId === attempt.id : true))
        .map((item) => ({
          id: item.id,
          resourceType: item.resourceType,
          state: item.state,
          stepId: stepIdOf(item),
        })),
    [resources.items, attempt],
  );
  const view = useMemo(() => {
    if (!revision) return null;
    const graph = buildDataFlow(revision.plan, attemptSteps, flowResources);
    return {
      graph,
      rows: describeFlowTable(graph, flowResources),
      stepRows: describeStepTable(revision.plan, graph),
    };
  }, [revision, attemptSteps, flowResources]);

  const loadingMore = revisions.status === "ready" && !revision && revisions.hasMore;
  let body: ReactNode;
  if (revisions.status === "loading" || loadingMore) body = <ViewState kind="loading" />;
  else if (revisions.status === "error" || revisions.status === "forbidden")
    body = (
      <ViewState
        kind={revisions.status === "forbidden" ? "forbidden" : "error"}
        error={revisions.error}
        onRetry={() => void revisions.reload()}
      />
    );
  else if (!view)
    body = (
      <ViewState
        kind="empty"
        title="Revision not in the loaded history"
        message="This Run's test revision was not found in the revision history of its test, so its data flow cannot be drawn. Nothing is guessed from other revisions."
      />
    );
  else {
    const orphans = orphanedResources(
      resources.items.map((item) => ({
        id: item.id,
        resourceType: item.resourceType,
        state: item.state,
      })),
    );
    const failed = [
      attempts.status === "error" ? "Attempts" : null,
      steps.status === "error" ? "step results" : null,
      resources.status === "error" ? "resources" : null,
    ].filter((name): name is string => name !== null);
    body = (
      <>
        {failed.length > 0 ? (
          <div className="banner tone-warning" role="status">
            <Icon shape="warn" />
            <span>
              Could not load {failed.join(", ")}. The graph shows the plan; runtime status may be
              missing.
            </span>
          </div>
        ) : null}
        {steps.status === "empty" ? (
          <p>No step results are recorded for this Run yet, so every step shows “No result”.</p>
        ) : null}
        {ordered.length > 1 ? (
          <p className="field-inline">
            <label htmlFor={selectId}>Attempt shown </label>
            <select
              id={selectId}
              value={attempt?.id ?? ""}
              onChange={(event) => setChosen(event.target.value)}
            >
              {ordered.map((item) => (
                <option key={item.id} value={item.id}>
                  Attempt {item.number} ({item.outcome ?? "in progress"})
                </option>
              ))}
            </select>
          </p>
        ) : attempt ? (
          <p>
            Showing Attempt {attempt.number} ({attempt.outcome ?? "in progress"}).
          </p>
        ) : null}
        <p>
          Plan: <UntrustedText value={revision?.plan.name} maxLength={160} /> (revision{" "}
          {revision?.ordinal}).
        </p>
        {orphans.length > 0 ? (
          <div className="banner tone-warning" role="status" data-testid="orphan-banner">
            <Icon shape="warn" />
            <span>
              {orphans.length} resource(s) of this Run are not confirmed cleaned up. They are listed
              below with their state; nothing is assumed gone.
            </span>
          </div>
        ) : null}
        <DataFlowGraphView
          graph={view.graph}
          title="Data flow of the Run"
          description={describeGraph(view.rows, view.graph.nodes.length, view.graph.edges.length)}
        />
        <DataTable
          caption="Data flow, as a table"
          columns={flowColumns}
          rows={view.rows}
          rowKey={(row) => row.key}
          empty={
            <ViewState
              kind="empty"
              title="No data flows"
              message="This revision has no variables, dependencies or resources to connect."
            />
          }
        />
        <DataTable
          caption="Steps, requests and latency"
          columns={stepColumns}
          rows={view.stepRows}
          rowKey={(row) => row.id}
        />
        <DataTable
          caption="Resources created by this Run"
          columns={resourceColumns}
          rows={resources.items}
          rowKey={(row) => row.id}
          empty={<p>This Run created no resources.</p>}
        />
      </>
    );
  }
  return <div className="data-flow-panel">{body}</div>;
}
