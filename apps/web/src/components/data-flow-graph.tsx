import { type ReactNode, useId } from "react";
import {
  type DataFlowGraph,
  type FlowEdge,
  type FlowNode,
  layoutDataFlow,
  nodeSize,
} from "../lib/data-flow";
import { sanitizeUntrusted } from "../lib/untrusted";
import { describeStatus, Icon, type StatusDescriptor } from "./status";
import "./data-flow-graph.css";

/** Resource states are not step verdicts, so they get their own wording, tone and shape. */
const resourceStates: Readonly<Record<string, StatusDescriptor>> = {
  planned: { label: "Planned", tone: "neutral", shape: "clock" },
  created: { label: "Created, not cleaned up", tone: "info", shape: "info" },
  cleanup_pending: { label: "Cleanup pending", tone: "warning", shape: "clock" },
  cleaned: { label: "Cleaned up", tone: "success", shape: "check" },
  orphaned: { label: "Orphaned", tone: "danger", shape: "warn" },
  uncertain: { label: "Uncertain", tone: "warning", shape: "question" },
};

export function describeResourceState(state: string): StatusDescriptor {
  return (
    resourceStates[state] ?? {
      label: state.replace(/[_-]+/g, " "),
      tone: "neutral",
      shape: "question",
    }
  );
}

/** What a node says about itself: text always, plus the shape that repeats it. */
export function describeNode(node: FlowNode): StatusDescriptor & { readonly detail: string } {
  if (node.resourceState) {
    const state = describeResourceState(node.resourceState);
    return { ...state, detail: state.label };
  }
  if (node.run) {
    const status = describeStatus(node.run.status);
    return { ...status, detail: `${status.label} · ${node.run.durationMs} ms` };
  }
  if (node.kind === "dependency")
    return { label: "Dependency", tone: "info", shape: "info", detail: "From another test" };
  if (node.kind === "resource")
    return { label: "Unknown", tone: "neutral", shape: "question", detail: "State not recorded" };
  return { label: "No result", tone: "neutral", shape: "clock", detail: "No result recorded" };
}

const clip = (value: string, maxLength: number): string => {
  const { text } = sanitizeUntrusted(value, { maxLength: 400 });
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
};

function edgeClass(edge: FlowEdge): string {
  if (edge.unresolved) return "flow-edge flow-edge-unresolved";
  return edge.sensitive ? "flow-edge flow-edge-sensitive" : "flow-edge";
}

export interface DataFlowGraphProps {
  readonly graph: DataFlowGraph;
  /** Accessible name of the graphic. */
  readonly title: string;
  /** Spoken summary; the table beside the graph carries the same information. */
  readonly description: string;
}

/**
 * Accessible SVG of producer/consumer edges. The graphic is one image to assistive technology,
 * so every node, edge and status is also in the equivalent table. Sensitive and unresolved edges
 * differ by line pattern and are explained in the text legend, not by colour alone.
 */
export function DataFlowGraphView({ graph, title, description }: DataFlowGraphProps): ReactNode {
  const base = useId().replace(/[^a-zA-Z0-9]/g, "");
  const titleId = `${base}-title`;
  const descriptionId = `${base}-desc`;
  const layout = layoutDataFlow(graph);
  const marker = (name: string) => `${base}-${name}`;
  const point = (id: string) => layout.positions[id];
  const labelsNeedRoom = graph.edges.length > 0;
  return (
    <div>
      {/* biome-ignore lint/a11y/useSemanticElements: a named scroll region keeps its label */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll it */}
      <div className="flow-scroll" role="region" aria-label="Data flow graph" tabIndex={0}>
        <svg
          className="flow-graph"
          role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
        >
          <title id={titleId}>{title}</title>
          <desc id={descriptionId}>{description}</desc>
          <defs>
            {(
              [
                ["arrow", "flow-marker"],
                ["arrow-sensitive", "flow-marker flow-marker-sensitive"],
                ["arrow-unresolved", "flow-marker flow-marker-unresolved"],
              ] as const
            ).map(([name, className]) => (
              <marker
                key={name}
                id={marker(name)}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M0 0 10 5 0 10Z" className={className} />
              </marker>
            ))}
          </defs>
          {graph.edges.map((edge) => {
            const target = point(edge.to);
            if (!target) return null;
            const end = { x: target.x, y: target.y + nodeSize.height / 2 };
            const source = edge.from === null ? undefined : point(edge.from);
            const start = source
              ? { x: source.x + nodeSize.width, y: source.y + nodeSize.height / 2 }
              : { x: end.x - 22, y: end.y };
            const bend = Math.max(24, (end.x - start.x) / 2);
            const path = source
              ? `M${start.x} ${start.y} C${start.x + bend} ${start.y} ${end.x - bend} ${end.y} ${end.x} ${end.y}`
              : `M${start.x} ${start.y} L${end.x} ${end.y}`;
            const arrow = edge.unresolved
              ? "arrow-unresolved"
              : edge.sensitive
                ? "arrow-sensitive"
                : "arrow";
            return (
              <g key={edge.id} data-edge={edge.id}>
                <path d={path} className={edgeClass(edge)} markerEnd={`url(#${marker(arrow)})`} />
                {labelsNeedRoom ? (
                  <text
                    className="flow-edge-label"
                    x={(start.x + end.x) / 2}
                    y={(start.y + end.y) / 2 - 6}
                    textAnchor="middle"
                  >
                    {edge.unresolved ? "? " : ""}
                    {clip(edge.name, 22)}
                  </text>
                ) : null}
              </g>
            );
          })}
          {graph.nodes.map((node) => {
            const position = point(node.id);
            if (!position) return null;
            const status = describeNode(node);
            const tag = `${node.operation ?? node.kind}${node.sensitive ? " · sensitive" : ""}`;
            return (
              <g
                key={node.id}
                data-node={node.id}
                transform={`translate(${position.x} ${position.y})`}
                className={`flow-node flow-tone-${status.tone}${node.sensitive ? " flow-sensitive" : ""}`}
              >
                <rect width={nodeSize.width} height={nodeSize.height} rx="6" />
                <text className="flow-node-title" x="10" y="21">
                  {clip(node.label, 24)}
                </text>
                <g transform="translate(10 29)">
                  <Icon shape={status.shape} />
                </g>
                <text x="30" y="41">
                  {clip(status.detail, 22)}
                </text>
                <text x="10" y="58">
                  {clip(tag, 28)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <ul className="flow-legend" aria-label="Graph legend">
        <li>
          <svg aria-hidden="true" focusable="false" viewBox="0 0 48 12">
            <line x1="0" y1="6" x2="48" y2="6" className="flow-edge-solid" />
          </svg>
          <span>Solid line: a value or resource passed from producer to consumer</span>
        </li>
        <li>
          <svg aria-hidden="true" focusable="false" viewBox="0 0 48 12">
            <line x1="0" y1="6" x2="48" y2="6" className="flow-edge-sensitive" />
          </svg>
          <span>Dashed line and node outline: sensitive value, never shown</span>
        </li>
        <li>
          <svg aria-hidden="true" focusable="false" viewBox="0 0 48 12">
            <line x1="0" y1="6" x2="48" y2="6" className="flow-edge-unresolved" />
          </svg>
          <span>Dotted line marked “?”: unresolved reference, nothing produces it</span>
        </li>
      </ul>
    </div>
  );
}
