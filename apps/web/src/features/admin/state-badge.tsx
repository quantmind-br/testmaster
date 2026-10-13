import type { ReactNode } from "react";
import { describeStatus, Icon, type StatusDescriptor } from "../../components/status";

/** Worker, integration, delivery and attempt states (ADR-018: text plus a shape, never colour alone). */
export const adminStates: Readonly<Record<string, StatusDescriptor>> = {
  enrolling: { label: "Enrolling", tone: "neutral", shape: "clock" },
  ready: { label: "Ready", tone: "success", shape: "check" },
  draining: { label: "Draining", tone: "warning", shape: "stop" },
  revoked: { label: "Revoked", tone: "danger", shape: "slash" },
  offline: { label: "Offline", tone: "warning", shape: "cross" },
  active: { label: "Active", tone: "success", shape: "check" },
  paused: { label: "Paused", tone: "neutral", shape: "stop" },
  pending: { label: "Pending", tone: "neutral", shape: "clock" },
  delivered: { label: "Delivered", tone: "success", shape: "check" },
  dead_letter: { label: "Dead letter · DLQ", tone: "danger", shape: "cross" },
  in_flight: { label: "In flight", tone: "info", shape: "spinner" },
  failed: { label: "Failed", tone: "danger", shape: "cross" },
  rejected: { label: "Rejected", tone: "danger", shape: "stop" },
  abandoned: { label: "Abandoned", tone: "neutral", shape: "slash" },
  uncertain: { label: "Outcome uncertain", tone: "warning", shape: "question" },
};

/** Unknown states fall back to the neutral question shape and are never shown as a success. */
export function StateBadge({ state }: { state: string }): ReactNode {
  const descriptor = adminStates[state] ?? describeStatus(state);
  return (
    <span className={`badge tone-${descriptor.tone}`} data-status={state}>
      <Icon shape={descriptor.shape} spin={descriptor.shape === "spinner"} />
      <span>{descriptor.label}</span>
    </span>
  );
}
