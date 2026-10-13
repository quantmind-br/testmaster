import type { StepRecord } from "./run-types";

/**
 * Data-flow graph of a test plan (REQ-053): which step produces each captured variable, which
 * steps consume it, which resources a step creates and which cleanup removes them. It is derived
 * only from the plan and the Run's recorded results; nothing is guessed. A reference with no
 * producer is shown as unresolved, never silently dropped.
 */
export interface PlanLike {
  readonly steps: readonly PlanStepLike[];
  readonly dependsOn?: readonly {
    readonly producerTestId: string;
    readonly outputName: string;
    readonly consumerInput: string;
    readonly sensitive: boolean;
    readonly required: boolean;
  }[];
  readonly cleanup?: readonly { readonly resourceRef: string }[];
}
export interface PlanStepLike {
  readonly id: string;
  readonly operation: string;
  readonly description?: string;
  readonly input?: unknown;
}

export type FlowNodeKind = "step" | "dependency" | "resource";
export interface FlowNode {
  readonly id: string;
  readonly kind: FlowNodeKind;
  readonly label: string;
  readonly operation: string | null;
  /** Variable names this node makes available. */
  readonly produces: readonly string[];
  readonly consumes: readonly string[];
  readonly run: {
    readonly status: string;
    readonly durationMs: number;
    readonly evidencePaths: readonly string[];
  } | null;
  /** True when the step captures a sensitive value, so its observed data is withheld. */
  readonly sensitive: boolean;
  /** Recorded state of the resource a resource or cleanup node stands for; `null` when unknown. */
  readonly resourceState: string | null;
}
export interface FlowEdge {
  readonly id: string;
  readonly kind: "variable" | "resource" | "dependency";
  readonly name: string;
  readonly from: string | null;
  readonly to: string;
  readonly sensitive: boolean;
  /** No producer in the plan: the reference cannot be satisfied by this revision. */
  readonly unresolved: boolean;
}
export interface DataFlowGraph {
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
}
export interface OrphanResource {
  readonly id: string;
  readonly resourceType: string;
  readonly state: string;
}
/** A recorded resource, tied to the plan step whose cleanup declaration owns it. */
export interface FlowResource extends OrphanResource {
  readonly stepId: string | null;
}

interface CaptureLike {
  readonly name?: unknown;
  readonly sensitive?: unknown;
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Every `{ variableRef }` reachable from `value`, in document order. */
export function variableRefs(value: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    if (typeof object.variableRef === "string") found.push(object.variableRef);
    for (const child of Object.values(object)) visit(child);
  };
  visit(value);
  return found;
}

/** Steps in plan order, with the children of a frame listed right after it. */
export function flattenSteps(steps: readonly PlanStepLike[]): PlanStepLike[] {
  return steps.flatMap((step) => {
    const children = record(step.input).childSteps;
    return step.operation === "frame" && Array.isArray(children)
      ? [step, ...flattenSteps(children as PlanStepLike[])]
      : [step];
  });
}

export function buildDataFlow(
  plan: PlanLike,
  steps: readonly StepRecord[] = [],
  resources: readonly FlowResource[] = [],
): DataFlowGraph {
  const results = new Map(steps.map((step) => [step.planStepId, step]));
  const resourceStates = new Map<string, string>();
  for (const resource of resources)
    if (resource.stepId) resourceStates.set(resource.stepId, resource.state);
  const planSteps = flattenSteps(plan.steps);
  const producers = new Map<string, { node: string; sensitive: boolean }>();
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const link = (
    kind: FlowEdge["kind"],
    name: string,
    from: string | null,
    to: string,
    sensitive: boolean,
  ) =>
    edges.push({
      id: `${kind}:${name}:${from ?? "none"}->${to}`,
      kind,
      name,
      from,
      to,
      sensitive,
      unresolved: from === null,
    });

  for (const binding of plan.dependsOn ?? []) {
    const id = `dependency:${binding.consumerInput}`;
    nodes.push({
      id,
      kind: "dependency",
      label: `Output ${binding.outputName} of test ${binding.producerTestId}`,
      operation: null,
      produces: [binding.consumerInput],
      consumes: [],
      run: null,
      sensitive: binding.sensitive,
      resourceState: null,
    });
    producers.set(binding.consumerInput, { node: id, sensitive: binding.sensitive });
  }
  for (const step of planSteps) {
    const input = record(step.input);
    const captures = Array.isArray(input.capture) ? (input.capture as CaptureLike[]) : [];
    for (const capture of captures) {
      if (typeof capture.name !== "string") continue;
      const entry = { node: step.id, sensitive: capture.sensitive === true };
      producers.set(capture.name, entry);
      producers.set(`${step.id}.${capture.name}`, entry);
    }
    if (step.operation === "request" && input.resource)
      producers.set(`${step.id}.handle`, { node: step.id, sensitive: false });
  }
  for (const step of planSteps) {
    const input = record(step.input);
    const captures = Array.isArray(input.capture) ? (input.capture as CaptureLike[]) : [];
    const produced = captures.flatMap((capture) =>
      typeof capture.name === "string" ? [capture.name] : [],
    );
    const resource = record(input.resource);
    const consumed = [...new Set(variableRefs(step.operation === "frame" ? null : step.input))];
    const result = results.get(step.id);
    nodes.push({
      id: step.id,
      kind: "step",
      label: step.description ?? step.id,
      operation: step.operation,
      produces: Object.keys(resource).length > 0 ? [...produced, `${step.id}.handle`] : produced,
      consumes: consumed,
      run: result
        ? {
            status: result.status,
            durationMs: result.durationMs,
            evidencePaths: result.evidenceRefs.map((ref) => ref.relativePath),
          }
        : null,
      sensitive: captures.some((capture) => capture.sensitive === true),
      resourceState: null,
    });
    for (const name of consumed) {
      const producer = producers.get(name);
      link("variable", name, producer?.node ?? null, step.id, producer?.sensitive ?? false);
    }
    if (typeof resource.resourceType === "string") {
      nodes.push({
        id: `resource:${step.id}`,
        kind: "resource",
        label: `Resource ${resource.resourceType}`,
        operation: null,
        produces: [],
        consumes: [],
        run: null,
        sensitive: false,
        resourceState: resourceStates.get(step.id) ?? null,
      });
      link("resource", resource.resourceType, step.id, `resource:${step.id}`, false);
    }
  }
  for (const [index, cleanup] of (plan.cleanup ?? []).entries()) {
    const owner = planSteps.find(
      (step) => cleanup.resourceRef === `${step.id}.handle` || cleanup.resourceRef === step.id,
    );
    const target = owner ? `resource:${owner.id}` : null;
    const id = `cleanup:${index}`;
    nodes.push({
      id,
      kind: "step",
      label: `Cleanup of ${cleanup.resourceRef}`,
      operation: "cleanup",
      produces: [],
      consumes: [],
      run: null,
      sensitive: false,
      resourceState: owner ? (resourceStates.get(owner.id) ?? null) : null,
    });
    link("resource", cleanup.resourceRef, target, id, false);
  }
  return { nodes, edges };
}

export interface FlowLayout {
  readonly width: number;
  readonly height: number;
  readonly positions: Readonly<Record<string, { x: number; y: number }>>;
}

const columnWidth = 240;
const rowHeight = 96;
const margin = 28;
export const nodeSize = { width: 190, height: 68 } as const;

/** Columns follow dependency depth, so every edge points from a lower column to a higher one. */
export function layoutDataFlow(graph: DataFlowGraph): FlowLayout {
  const depth = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges)
    if (edge.from) incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  const resolve = (id: string, trail: ReadonlySet<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (trail.has(id)) return 0;
    const next = new Set(trail).add(id);
    const value = Math.max(-1, ...(incoming.get(id) ?? []).map((from) => resolve(from, next))) + 1;
    depth.set(id, value);
    return value;
  };
  const rows = new Map<number, number>();
  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of graph.nodes) {
    const column = resolve(node.id, new Set());
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    positions[node.id] = { x: margin + column * columnWidth, y: margin + row * rowHeight };
  }
  const columns = Math.max(0, ...depth.values()) + 1;
  return {
    width: margin * 2 + (columns - 1) * columnWidth + nodeSize.width,
    height: margin * 2 + (Math.max(1, ...rows.values()) - 1) * rowHeight + nodeSize.height,
    positions,
  };
}

/** Resources a Run left behind: anything not cleaned is reported, never assumed gone. */
export function orphanedResources<T extends OrphanResource>(resources: readonly T[]): T[] {
  const open = ["orphaned", "uncertain", "cleanup_pending", "created", "planned"];
  return resources.filter((resource) => open.includes(resource.state));
}

export interface FlowTableRow {
  readonly key: string;
  /** Variable or resource name, as written in the plan. */
  readonly name: string;
  readonly producedBy: string | null;
  readonly consumedBy: string | null;
  /** Sensitive values are only ever described, never carried: the table masks them. */
  readonly sensitive: boolean;
  /** Result of the producer in the selected Attempt, or the resource state for a resource. */
  readonly producerStatus: { readonly kind: "step" | "resource"; readonly status: string } | null;
  readonly latencyMs: number | null;
  readonly notes: readonly string[];
}

export const maskedValue = "••• hidden";

/**
 * The table equivalent of the graph: one row per edge, one per variable that is captured but never
 * used, and one per left-over resource that no plan step explains. Nothing the graph shows is
 * missing here, and no row carries a value.
 */
export function describeFlowTable(
  graph: DataFlowGraph,
  resources: readonly FlowResource[] = [],
): FlowTableRow[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const labelOf = (id: string | null): string | null =>
    id === null ? null : (byId.get(id)?.label ?? id);
  const statusOf = (node: FlowNode | undefined): FlowTableRow["producerStatus"] => {
    if (!node) return null;
    if (node.resourceState) return { kind: "resource", status: node.resourceState };
    return node.run ? { kind: "step", status: node.run.status } : null;
  };
  const rows: FlowTableRow[] = [];
  for (const edge of graph.edges) {
    const producer = edge.from === null ? undefined : byId.get(edge.from);
    const consumer = byId.get(edge.to);
    const notes: string[] = [];
    if (edge.unresolved)
      notes.push(
        edge.kind === "variable"
          ? "Unresolved reference: nothing in this revision produces this variable."
          : "Unresolved reference: no step in this revision creates this resource.",
      );
    if (edge.sensitive)
      notes.push(
        "Sensitive: the value is never shown and observed data of the producing step is withheld.",
      );
    const state = consumer?.kind === "resource" ? consumer.resourceState : null;
    if (state && ["orphaned", "uncertain", "cleanup_pending", "created", "planned"].includes(state))
      notes.push(`Resource is ${state.replace(/_/g, " ")}: cleanup is not confirmed.`);
    rows.push({
      key: edge.id,
      name: edge.name,
      producedBy: labelOf(edge.from),
      consumedBy: labelOf(edge.to),
      sensitive: edge.sensitive,
      producerStatus: statusOf(producer),
      latencyMs: producer?.run?.durationMs ?? null,
      notes,
    });
  }
  for (const node of graph.nodes) {
    for (const name of node.produces) {
      // A resource handle is consumed by the resource node and its cleanup, which have their own rows.
      const covered = name === `${node.id}.handle` && byId.has(`resource:${node.id}`);
      const used =
        covered ||
        graph.edges.some(
          (edge) =>
            edge.from === node.id && (edge.name === name || edge.name === `${node.id}.${name}`),
        );
      if (used) continue;
      rows.push({
        key: `unused:${node.id}:${name}`,
        name,
        producedBy: node.label,
        consumedBy: null,
        sensitive: node.sensitive,
        producerStatus: statusOf(node),
        latencyMs: node.run?.durationMs ?? null,
        notes: node.sensitive
          ? [
              "Produced but never referenced by a later step.",
              "Sensitive: the value is never shown and observed data of this step is withheld.",
            ]
          : ["Produced but never referenced by a later step."],
      });
    }
  }
  const explained = new Set(
    graph.nodes.flatMap((node) => (node.kind === "resource" ? [node.id] : [])),
  );
  for (const resource of orphanedResources(resources)) {
    if (resource.stepId !== null && explained.has(`resource:${resource.stepId}`)) continue;
    rows.push({
      key: `orphan:${resource.id}`,
      name: resource.resourceType,
      producedBy: resource.stepId,
      consumedBy: null,
      sensitive: false,
      producerStatus: { kind: "resource", status: resource.state },
      latencyMs: null,
      notes: [
        `Resource ${resource.id} is ${resource.state.replace(/_/g, " ")} and no step of this revision declares it.`,
      ],
    });
  }
  return rows;
}

export interface StepTableRow {
  readonly id: string;
  readonly label: string;
  readonly operation: string;
  /** `METHOD path` with variables shown by name, never by value; `null` for non-request steps. */
  readonly request: string | null;
  readonly result: { readonly status: string; readonly durationMs: number } | null;
  /** The step captures a sensitive value, so what it observed is withheld. */
  readonly observedWithheld: boolean;
}

function pathSegment(segment: unknown): string {
  const value = record(segment);
  if (typeof value.literal === "string") return value.literal;
  if (typeof value.variableRef === "string") return `{${value.variableRef}}`;
  if (typeof value.secretRef === "string") return "{secret}";
  return "{?}";
}

/** `GET /orders/{order-id}` for a request step; variables appear by name only. */
export function describeRequestLine(input: unknown): string | null {
  const request = record(input);
  if (typeof request.method !== "string" || !Array.isArray(request.pathSegments)) return null;
  return `${request.method} /${request.pathSegments.map(pathSegment).join("/")}`;
}

/** Request, result and latency per plan step, in plan order, for the Attempt on screen. */
export function describeStepTable(plan: PlanLike, graph: DataFlowGraph): StepTableRow[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return flattenSteps(plan.steps).map((step) => {
    const node = nodes.get(step.id);
    return {
      id: step.id,
      label: step.description ?? step.id,
      operation: step.operation,
      request: step.operation === "request" ? describeRequestLine(step.input) : null,
      result: node?.run ? { status: node.run.status, durationMs: node.run.durationMs } : null,
      observedWithheld: node?.sensitive ?? false,
    };
  });
}
