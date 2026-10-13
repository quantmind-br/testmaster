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

export function buildDataFlow(plan: PlanLike, steps: readonly StepRecord[] = []): DataFlowGraph {
  const results = new Map(steps.map((step) => [step.planStepId, step]));
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
    });
    producers.set(binding.consumerInput, { node: id, sensitive: binding.sensitive });
  }
  for (const step of plan.steps) {
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
  for (const step of plan.steps) {
    const input = record(step.input);
    const captures = Array.isArray(input.capture) ? (input.capture as CaptureLike[]) : [];
    const produced = captures.flatMap((capture) =>
      typeof capture.name === "string" ? [capture.name] : [],
    );
    const resource = record(input.resource);
    const consumed = [...new Set(variableRefs(step.input))];
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
      });
      link("resource", resource.resourceType, step.id, `resource:${step.id}`, false);
    }
  }
  for (const [index, cleanup] of (plan.cleanup ?? []).entries()) {
    const owner = plan.steps.find(
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

const columnWidth = 220;
const rowHeight = 84;
const margin = 24;
export const nodeSize = { width: 180, height: 52 } as const;

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
export function orphanedResources(
  resources: readonly { id: string; resourceType: string; state: string }[],
): OrphanResource[] {
  const open = ["orphaned", "uncertain", "cleanup_pending", "created", "planned"];
  return resources.filter((resource) => open.includes(resource.state));
}
